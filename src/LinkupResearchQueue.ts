import type { LinkupResearchResponse, ResearchOutputFor, ResearchParams } from "./linkupTypes";
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

type Listener<TParams extends ResearchParams<any>> = (event: QueueEvent<TParams>) => void;

const DEFAULT_SNAPSHOT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_SNAPSHOT_MAX_ENTRIES = 1000;

/**
 * Queue wrapper for Linkup /research. Handles batching, polling, and status events.
 */
export class LinkupResearchQueue<TParams extends ResearchParams<any> = ResearchParams> {
  private readonly client: LinkupClient;
  private readonly options: QueueOptions<TParams>;
  private readonly state: QueueState<TParams>;
  private readonly snapshots: SnapshotStore<TParams>;
  private readonly listeners = new Set<Listener<TParams>>();
  private readonly engine: QueueEngine<TParams>;
  private requestCounter = 0;

  constructor(client: LinkupClient, options: QueueOptions<TParams> = {}) {
    this.client = client;
    this.options = options;
    this.state = new QueueState<TParams>();
    const snapshotTtlMs =
      options.snapshotTtlMs === null ? undefined : options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
    const snapshotMaxEntries =
      options.snapshotMaxEntries === null ? undefined : options.snapshotMaxEntries ?? DEFAULT_SNAPSHOT_MAX_ENTRIES;
    this.snapshots = new SnapshotStore<TParams>({
      ttlMs: snapshotTtlMs,
      maxEntries: snapshotMaxEntries,
    });
    this.engine = new QueueEngine<TParams>({
      client: this.client,
      options: this.options,
      state: this.state,
      emit: (event) => this.emit(event),
    });
  }

  /**
   * Enqueue a single research request.
   */
  add(params: TParams): QueueHandle<TParams> {
    if (this.engine.isStopped) {
      throw new Error("Queue is stopped.");
    }
    const requestId = (this.requestCounter += 1);
    const idDeferred = createDeferred<string>();
    const doneDeferred = createDeferred<LinkupResearchResponse<ResearchOutputFor<TParams>>>();

    const task: QueueTask<TParams> = {
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
  batch(paramsList: TParams[]): QueueHandle<TParams>[] {
    if (this.engine.isStopped) {
      throw new Error("Queue is stopped.");
    }
    const handles: QueueHandle<TParams>[] = [];
    const tasks: QueueTask<TParams>[] = [];

    for (const params of paramsList) {
      const requestId = (this.requestCounter += 1);
      const idDeferred = createDeferred<string>();
      const doneDeferred = createDeferred<LinkupResearchResponse<ResearchOutputFor<TParams>>>();

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
  listen(handler: Listener<TParams>): ListenerHandle {
    this.listeners.add(handler);
    return {
      unlisten: () => this.listeners.delete(handler),
    };
  }

  /**
   * Active tasks with taskId assigned (ready for GET /research/{id}).
   */
  active(): ActiveEntry<TParams>[] {
    return this.state.listActive();
  }

  /**
   * Tasks waiting to start (no taskId yet).
   */
  queued(): QueuedEntry<TParams>[] {
    return this.state.listQueued();
  }

  /**
   * Snapshot of all known tasks (queued/active/completed/error).
   */
  all(): CheckAllEntry<TParams>[] {
    return this.checkAllSync();
  }

  /**
   * Live status check from API for a queued requestId (must be started).
   */
  async check(requestId: number): Promise<LinkupResearchResponse<ResearchOutputFor<TParams>>> {
    const activeTask = this.state.getActive(requestId);
    if (!activeTask?.taskId) {
      throw new Error("Task has not started yet or taskId is unavailable.");
    }
    return await this.client.check<ResearchOutputFor<TParams>>(activeTask.taskId, { retry: this.options.retry });
  }

  /**
   * Live status check from API for a Linkup taskId.
   */
  async checkByTaskId(taskId: string): Promise<LinkupResearchResponse<ResearchOutputFor<TParams>>> {
    return await this.client.check<ResearchOutputFor<TParams>>(taskId, { retry: this.options.retry });
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
    return await runCheckAll<TParams>(
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
    const results: CheckAllEntry<TParams>[] = [];

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
    return await runCheckAll<TParams>(
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
    const results: CheckAllEntry<TParams>[] = [];
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
  async waitAll(handles: QueueHandle<TParams>[]): Promise<LinkupResearchResponse<ResearchOutputFor<TParams>>[]> {
    return await Promise.all(handles.map((handle) => handle.done));
  }

  /**
   * Await all handles, capturing errors (utility wrapper).
   */
  async waitAllSettled(
    handles: QueueHandle<TParams>[],
  ): Promise<PromiseSettledResult<LinkupResearchResponse<ResearchOutputFor<TParams>>>[]> {
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

  private emit(event: QueueEvent<TParams>) {
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
