import type { LinkupClient } from "../LinkupClient";
import type { ResearchOutputFor, ResearchParams } from "../linkupTypes";
import type { QueueEvent, QueueOptions } from "./types";
import { QueueState, type QueueTask } from "./state";

type Command<TParams extends ResearchParams<any>> =
  | {
      tasks: QueueTask<TParams>[];
    }
  | {
      stop: true;
    };

type Emit<TParams extends ResearchParams<any>> = (event: QueueEvent<TParams>) => void;

type EngineDeps<TParams extends ResearchParams<any>> = {
  client: LinkupClient;
  options: QueueOptions<TParams>;
  state: QueueState<TParams>;
  emit: Emit<TParams>;
};

export class QueueEngine<TParams extends ResearchParams<any> = ResearchParams> {
  private readonly client: LinkupClient;
  private readonly options: QueueOptions<TParams>;
  private readonly state: QueueState<TParams>;
  private readonly emitEvent: Emit<TParams>;
  private readonly controller: AsyncGenerator<undefined, void, Command<TParams> | undefined>;
  private readonly commandQueue: Command<TParams>[] = [];
  private readonly abortControllers = new Map<number, AbortController>();
  private readonly cancelled = new Set<number>();
  private running = true;
  private stopping = false;
  private stopError: Error | null = null;
  private runningCount = 0;
  private drainingCommands = false;
  private drainingQueue = false;
  private controllerPrimed = false;

  constructor(deps: EngineDeps<TParams>) {
    this.client = deps.client;
    this.options = deps.options;
    this.state = deps.state;
    this.emitEvent = deps.emit;
    this.controller = this.controlLoop();
    void this.primeController();
  }

  get isStopped() {
    return this.stopping || !this.running;
  }

  enqueue(tasks: QueueTask<TParams>[]) {
    if (this.isStopped) {
      throw new Error("Queue is stopped.");
    }
    for (const task of tasks) {
      if (!this.abortControllers.has(task.requestId)) {
        this.abortControllers.set(task.requestId, new AbortController());
      }
    }
    this.enqueueCommand({ tasks });
  }

  stop() {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.stopError = new Error("Queue stopped");

    const pendingCommands = this.commandQueue.splice(0, this.commandQueue.length);
    for (const command of pendingCommands) {
      if ("tasks" in command) {
        for (const task of command.tasks) {
          this.cancelled.add(task.requestId);
          this.abort(task.requestId);
          this.rejectTask(task);
        }
      }
    }

    const { queuedTasks, activeTasks } = this.state.drainAll();
    for (const task of queuedTasks) {
      this.cancelled.add(task.requestId);
      this.abort(task.requestId);
      this.rejectTask(task);
    }
    for (const active of activeTasks) {
      this.cancelled.add(active.task.requestId);
      this.abort(active.task.requestId);
      this.rejectTask(active.task, active.taskId);
    }

    this.enqueueCommand({ stop: true });
  }

  cancel(requestId: number) {
    if (this.cancelled.has(requestId)) {
      return false;
    }
    for (let i = 0; i < this.commandQueue.length; i += 1) {
      const command = this.commandQueue[i];
      if (!("tasks" in command)) {
        continue;
      }
      const index = command.tasks.findIndex((task) => task.requestId === requestId);
      if (index >= 0) {
        const [task] = command.tasks.splice(index, 1);
        if (command.tasks.length === 0) {
          this.commandQueue.splice(i, 1);
        }
        this.cancelled.add(requestId);
        this.abort(requestId);
        this.rejectTask(task);
        return true;
      }
    }

    const queuedTask = this.state.removeQueued(requestId);
    if (queuedTask) {
      this.cancelled.add(requestId);
      this.abort(requestId);
      this.rejectTask(queuedTask);
      return true;
    }

    const active = this.state.getActive(requestId);
    if (active) {
      this.cancelled.add(requestId);
      this.abort(requestId);
      this.rejectTask(active.task, active.taskId);
      this.state.removeActive(requestId);
      return true;
    }

    return false;
  }

  private emit(event: QueueEvent<TParams>) {
    this.emitEvent(event);
  }

  private enqueueCommand(command: Command<TParams>) {
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
      const command: Command<TParams> | undefined = yield;
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
      while (this.running && !this.stopping) {
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

  private async startTask(task: QueueTask<TParams>) {
    if (this.stopping) {
      this.cleanup(task.requestId);
      this.runningCount -= 1;
      void this.drainQueue();
      return;
    }
    const controller = this.getController(task.requestId);
    let taskId: string | undefined;
    try {
      const start = await this.client.search(task.params, { signal: controller.signal });
      taskId = start.id;

      if (this.stopping) {
        this.cleanup(task.requestId);
        this.runningCount -= 1;
        void this.drainQueue();
        return;
      }

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
      if (this.isCancelled(task.requestId)) {
        return;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit({ type: "error", requestId: task.requestId, taskId, error: err });
      task.rejectId(err);
      task.rejectDone(err);
      this.cleanup(task.requestId);
      this.runningCount -= 1;
      void this.drainQueue();
    }
  }

  private async pollTask(task: QueueTask<TParams>, taskId: string) {
    try {
      if (this.isCancelled(task.requestId)) {
        return;
      }
      const controller = this.getController(task.requestId);
      const result = await this.client.poll<ResearchOutputFor<TParams>>(taskId, {
        pollIntervalMs: this.options.pollIntervalMs,
        timeoutMs: this.options.timeoutMs,
        retry: this.options.retry,
        signal: controller.signal,
        onStatus: (info) => {
          if (this.stopping || this.isCancelled(task.requestId)) {
            return;
          }
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

      if (this.stopping) {
        return;
      }
      this.emit({ type: "completed", requestId: task.requestId, taskId, result });
      task.resolveDone(result);
    } catch (error) {
      if (this.stopping || this.isCancelled(task.requestId)) {
        return;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit({ type: "error", requestId: task.requestId, taskId, error: err });
      task.rejectDone(err);
    } finally {
      this.cleanup(task.requestId);
      this.runningCount -= 1;
      this.abortControllers.delete(task.requestId);
      this.cancelled.delete(task.requestId);
      void this.drainQueue();
    }
  }

  private cleanup(requestId: number) {
    this.state.removeActive(requestId);
  }

  private getController(requestId: number) {
    let controller = this.abortControllers.get(requestId);
    if (!controller) {
      controller = new AbortController();
      this.abortControllers.set(requestId, controller);
    }
    return controller;
  }

  private abort(requestId: number) {
    const controller = this.abortControllers.get(requestId);
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    this.abortControllers.delete(requestId);
  }

  private isCancelled(requestId: number) {
    return this.cancelled.has(requestId);
  }

  private rejectTask(task: QueueTask<TParams>, taskId?: string) {
    const err = this.stopError ?? new Error("Queue stopped");
    this.emit({ type: "error", requestId: task.requestId, taskId, error: err });
    task.rejectId(err);
    task.rejectDone(err);
  }
}
