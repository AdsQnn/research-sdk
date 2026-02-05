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

type Command =
  | {
      tasks: QueueTask[];
    }
  | {
      stop: true;
    };

type Listener = (event: QueueEvent) => void;

/**
 * Queue wrapper for Linkup /research. Handles batching, polling, and status events.
 */
export class LinkupResearchQueue {
  private readonly client: LinkupClient;
  private readonly options: QueueOptions;
  private readonly state = new QueueState();
  private readonly snapshots: SnapshotStore;
  private readonly listeners = new Set<Listener>();
  private readonly commandQueue: Command[] = [];
  private readonly controller: AsyncGenerator<undefined, void, Command | undefined>;
  private requestCounter = 0;
  private running = true;
  private runningCount = 0;
  private drainingCommands = false;
  private drainingQueue = false;
  private controllerPrimed = false;

  constructor(client: LinkupClient, options: QueueOptions = {}) {
    this.client = client;
    this.options = options;
    this.snapshots = new SnapshotStore({
      ttlMs: options.snapshotTtlMs,
      maxEntries: options.snapshotMaxEntries,
    });
    this.controller = this.controlLoop();
    void this.primeController();
  }

  /**
   * Enqueue a single research request.
   */
  add(params: ResearchParams): QueueHandle {
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

    this.enqueueCommand({ tasks: [task] });
    return { requestId, id: idDeferred.promise, done: doneDeferred.promise };
  }

  /**
   * Enqueue multiple requests at once.
   */
  batch(paramsList: ResearchParams[]): QueueHandle[] {
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
      this.enqueueCommand({ tasks });
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
    return await runCheckAll(targets, this.client, this.snapshots, this.options.retry);
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
    return await runCheckAll(targets, this.client, this.snapshots, this.options.retry);
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

  stop() {
    this.running = false;
    this.enqueueCommand({ stop: true });
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

  private enqueueCommand(command: Command) {
    this.commandQueue.push(command);
    void this.drainCommands();
  }

  private async primeController() {
    if (this.controllerPrimed) {
      return;
    }
    this.controllerPrimed = true;
    await this.controller.next();
  }

  private async drainCommands() {
    if (this.drainingCommands) {
      return;
    }
    this.drainingCommands = true;
    await this.primeController();

    try {
      while (this.commandQueue.length > 0 && this.running) {
        const command = this.commandQueue.shift();
        if (!command) {
          continue;
        }
        await this.controller.next(command);
      }
    } finally {
      this.drainingCommands = false;
    }
  }

  private async *controlLoop() {
    while (this.running) {
      const command: Command | undefined = yield;
      if (!command) {
        continue;
      }
      if ("stop" in command) {
        this.running = false;
        return;
      }

      for (const task of command.tasks) {
        this.state.enqueue(task);
        this.emit({ type: "enqueued", requestId: task.requestId, params: task.params });
      }

      await this.drainQueue();
    }
  }

  private async drainQueue() {
    if (this.drainingQueue) {
      return;
    }
    this.drainingQueue = true;

    try {
      const concurrency = this.options.concurrency ?? 5;
      while (this.running) {
        const available = concurrency - this.runningCount;
        if (available <= 0) {
          return;
        }
        const toStart = this.state.take(available);
        if (toStart.length === 0) {
          return;
        }

        this.runningCount += toStart.length;
        await Promise.all(toStart.map((task) => this.startTask(task)));
      }
    } finally {
      this.drainingQueue = false;
    }
  }

  private async startTask(task: QueueTask) {
    let taskId: string | undefined;
    try {
      const start = await this.client.search(task.params);
      taskId = start.id;

      this.state.setTaskId(task.requestId, taskId);
      task.resolveId(taskId);
      this.emit({
        type: "started",
        requestId: task.requestId,
        taskId,
        params: task.params,
      });

      void this.pollTask(task, taskId);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit({ type: "error", requestId: task.requestId, taskId, error: err });
      task.rejectId(err);
      task.rejectDone(err);
      this.cleanup(task.requestId);
      this.runningCount -= 1;
      void this.drainQueue();
    }
  }

  private async pollTask(task: QueueTask, taskId: string) {
    try {
      const result = await this.client.poll(taskId, {
        pollIntervalMs: this.options.pollIntervalMs,
        timeoutMs: this.options.timeoutMs,
        retry: this.options.retry,
        onStatus: (info) => {
          this.emit({
            type: "status",
            requestId: task.requestId,
            taskId,
            status: info.status,
            response: info.response,
            elapsedMs: info.elapsedMs,
          });
        },
      });

      this.emit({ type: "completed", requestId: task.requestId, taskId, result });
      task.resolveDone(result);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit({ type: "error", requestId: task.requestId, taskId, error: err });
      task.rejectDone(err);
    } finally {
      this.cleanup(task.requestId);
      this.runningCount -= 1;
      void this.drainQueue();
    }
  }

  private cleanup(requestId: number) {
    this.state.removeActive(requestId);
  }
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
