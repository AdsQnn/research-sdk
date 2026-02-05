import type { LinkupResearchResponse, ResearchParams } from "./LinkupClient";
import { LinkupClient } from "./LinkupClient";
import type {
  ActiveEntry,
  CheckAllEntry,
  QueuedEntry,
  QueueEvent,
  QueueHandle,
  QueueOptions,
  ListenerHandle,
} from "./queue/types";
import { createDeferred } from "./queue/deferred";
import { QueueState, type QueueTask } from "./queue/state";
import { SnapshotStore } from "./queue/snapshots";
import { collectTargets, collectTargetsByTaskId } from "./queue/targets";
import { runCheckAll } from "./queue/checks";
import { QueueEngine } from "./queue/engine";

type Listener = (event: QueueEvent) => void;

const DEFAULT_SNAPSHOT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_SNAPSHOT_MAX_ENTRIES = 1000;

/**
 * Queue wrapper for Linkup /research. Handles batching, polling, and status events.
 */
export class LinkupResearchQueue {
  private readonly client: LinkupClient;
  private readonly options: QueueOptions;
  private readonly state = new QueueState();
  private readonly snapshots: SnapshotStore;
  private readonly listeners = new Set<Listener>();
  private readonly engine: QueueEngine;
  private requestCounter = 0;

  constructor(client: LinkupClient, options: QueueOptions = {}) {
    this.client = client;
    this.options = options;
    const snapshotTtlMs =
      options.snapshotTtlMs === null ? undefined : options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
    const snapshotMaxEntries =
      options.snapshotMaxEntries === null ? undefined : options.snapshotMaxEntries ?? DEFAULT_SNAPSHOT_MAX_ENTRIES;
    this.snapshots = new SnapshotStore({
      ttlMs: snapshotTtlMs,
      maxEntries: snapshotMaxEntries,
    });
    this.engine = new QueueEngine({
      client: this.client,
      options: this.options,
      state: this.state,
      emit: (event) => this.emit(event),
    });
  }

  /**
   * Enqueue a single research request.
   */
  add(params: ResearchParams): QueueHandle {
    if (this.engine.isStopped) {
      throw new Error("Queue is stopped.");
    }
    const requestId = (this.requestCounter += 1);
    const idDeferred = createDeferred<string>();
    const doneDeferred = createDeferred<LinkupResearchResponse>();

    const task: QueueTask = {
      requestId,
      params,
      resolveId: idDeferred.resolve,
      rejectId: idDeferred.reject,
      resolveDone: doneDeferred.resolve,
      rejectDone: doneDeferred.reject,
    };

    this.engine.enqueue([task]);
    return { requestId, id: idDeferred.promise, done: doneDeferred.promise };
  }

  /**
   * Enqueue multiple requests at once.
   */
  batch(paramsList: ResearchParams[]): QueueHandle[] {
    if (this.engine.isStopped) {
      throw new Error("Queue is stopped.");
    }
    const handles: QueueHandle[] = [];
    const tasks: QueueTask[] = [];

    for (const params of paramsList) {
      const requestId = (this.requestCounter += 1);
      const idDeferred = createDeferred<string>();
      const doneDeferred = createDeferred<LinkupResearchResponse>();

      tasks.push({
        requestId,
        params,
        resolveId: idDeferred.resolve,
        rejectId: idDeferred.reject,
        resolveDone: doneDeferred.resolve,
        rejectDone: doneDeferred.reject,
      });
      handles.push({ requestId, id: idDeferred.promise, done: doneDeferred.promise });
    }

    if (tasks.length > 0) {
      this.engine.enqueue(tasks);
    }

    return handles;
  }

  /**
   * Listen to queue events (enqueued/started/status/completed/error).
   * Returns a handle with unlisten().
   */
  listen(handler: Listener): ListenerHandle {
    this.listeners.add(handler);
    return {
      unlisten: () => this.listeners.delete(handler),
    };
  }

  /**
   * Active tasks with taskId assigned (ready for GET /research/{id}).
   */
  active(): ActiveEntry[] {
    return this.state.listActive();
  }

  /**
   * Tasks waiting to start (no taskId yet).
   */
  queued(): QueuedEntry[] {
    return this.state.listQueued();
  }

  /**
   * Snapshot of all known tasks (queued/active/completed/error).
   */
  all(): CheckAllEntry[] {
    return this.checkAllSync();
  }

  /**
   * Live status check from API for a queued requestId (must be started).
   */
  async check(requestId: number) {
    const activeTask = this.state.getActive(requestId);
    if (!activeTask?.taskId) {
      throw new Error("Task has not started yet or taskId is unavailable.");
    }
    return await this.client.check(activeTask.taskId, { retry: this.options.retry });
  }

  /**
   * Live status check from API for a Linkup taskId.
   */
  async checkByTaskId(taskId: string) {
    return await this.client.check(taskId, { retry: this.options.retry });
  }

  /**
   * Snapshot lookup (no network).
   */
  checkSync(requestId: number) {
    return this.snapshots.get(requestId);
  }

  /**
   * Snapshot lookup by taskId (no network).
   */
  checkByTaskIdSync(taskId: string) {
    return this.snapshots.getByTaskId(taskId);
  }

  /**
   * Live status check for active tasks (GET /research/{id}).
   */
  async checkAll(requestIds?: number[]) {
    const targets = collectTargets(requestIds, this.state);
    return await runCheckAll(
      targets,
      this.client,
      this.snapshots,
      this.options.retry,
      this.options.checkConcurrency,
    );
  }

  /**
   * Snapshot list without hitting the API.
   */
  checkAllSync(requestIds?: number[]) {
    const filter = requestIds ? new Set(requestIds) : undefined;
    const results: CheckAllEntry[] = [];

    if (filter) {
      for (const requestId of filter) {
        const snapshot = this.snapshots.get(requestId);
        results.push(snapshot ?? { requestId, notTracked: true });
      }
      return results;
    }

    return this.snapshots.getAll();
  }

  /**
   * Live status check by taskId list.
   */
  async checkAllByTaskId(taskIds?: string[]) {
    const targets = collectTargetsByTaskId(taskIds, this.state, this.snapshots);
    return await runCheckAll(
      targets,
      this.client,
      this.snapshots,
      this.options.retry,
      this.options.checkConcurrency,
    );
  }

  /**
   * Snapshot list by taskId list.
   */
  checkAllByTaskIdSync(taskIds?: string[]) {
    const results: CheckAllEntry[] = [];
    const filter = taskIds ? new Set(taskIds) : undefined;
    if (!filter) {
      return this.snapshots.getAll();
    }
    for (const taskId of filter) {
      const requestId = this.snapshots.getRequestId(taskId);
      if (requestId === undefined) {
        results.push({ requestId: -1, taskId, notTracked: true });
        continue;
      }
      const snapshot = this.snapshots.get(requestId);
      results.push(snapshot ?? { requestId, taskId, notTracked: true });
    }
    return results;
  }

  /**
   * Await all handles (utility wrapper).
   */
  async waitAll(handles: QueueHandle[]): Promise<LinkupResearchResponse[]> {
    return await Promise.all(handles.map((handle) => handle.done));
  }

  /**
   * Await all handles, capturing errors (utility wrapper).
   */
  async waitAllSettled(
    handles: QueueHandle[],
  ): Promise<PromiseSettledResult<LinkupResearchResponse>[]> {
    return await Promise.allSettled(handles.map((handle) => handle.done));
  }

  /**
   * Get taskId for a requestId if started.
   */
  getTaskId(requestId: number) {
    return this.state.getTaskId(requestId);
  }

  /**
   * Cancel a queued or active request by requestId (aborts local polling).
   */
  cancel(requestId: number) {
    return this.engine.cancel(requestId);
  }

  /**
   * Cancel by Linkup taskId (if tracked).
   */
  cancelByTaskId(taskId: string) {
    const requestId = this.snapshots.getRequestId(taskId) ?? this.state.findRequestIdByTaskId(taskId);
    if (requestId === undefined) {
      return false;
    }
    return this.engine.cancel(requestId);
  }

  stop() {
    this.engine.stop();
  }

  private emit(event: QueueEvent) {
    this.snapshots.record(event);
    for (const handler of this.listeners) {
      try {
        handler(event);
      } catch {
        // ignore listener errors to avoid breaking the queue
      }
    }
  }

  // queue engine handles the control loop and polling
}

export type {
  ActiveEntry,
  CheckAllEntry,
  QueuedEntry,
  QueueEvent,
  QueueHandle,
  QueueOptions,
  ListenerHandle,
} from "./queue/types";
