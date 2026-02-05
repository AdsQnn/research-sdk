import type { LinkupClient } from "../LinkupClient";
import type { QueueEvent, QueueOptions } from "./types";
import { QueueState, type QueueTask } from "./state";

type Command =
  | {
      tasks: QueueTask[];
    }
  | {
      stop: true;
    };

type Emit = (event: QueueEvent) => void;

type EngineDeps = {
  client: LinkupClient;
  options: QueueOptions;
  state: QueueState;
  emit: Emit;
};

export class QueueEngine {
  private readonly client: LinkupClient;
  private readonly options: QueueOptions;
  private readonly state: QueueState;
  private readonly emitEvent: Emit;
  private readonly controller: AsyncGenerator<undefined, void, Command | undefined>;
  private readonly commandQueue: Command[] = [];
  private running = true;
  private stopping = false;
  private stopError: Error | null = null;
  private runningCount = 0;
  private drainingCommands = false;
  private drainingQueue = false;
  private controllerPrimed = false;

  constructor(deps: EngineDeps) {
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

  enqueue(tasks: QueueTask[]) {
    if (this.isStopped) {
      throw new Error("Queue is stopped.");
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
          this.rejectTask(task);
        }
      }
    }

    const { queuedTasks, activeTasks } = this.state.drainAll();
    for (const task of queuedTasks) {
      this.rejectTask(task);
    }
    for (const active of activeTasks) {
      this.rejectTask(active.task, active.taskId);
    }

    this.enqueueCommand({ stop: true });
  }

  private emit(event: QueueEvent) {
    this.emitEvent(event);
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

  private async startTask(task: QueueTask) {
    if (this.stopping) {
      this.cleanup(task.requestId);
      this.runningCount -= 1;
      void this.drainQueue();
      return;
    }
    let taskId: string | undefined;
    try {
      const start = await this.client.search(task.params);
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
          if (this.stopping) {
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
      if (this.stopping) {
        return;
      }
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

  private rejectTask(task: QueueTask, taskId?: string) {
    const err = this.stopError ?? new Error("Queue stopped");
    this.emit({ type: "error", requestId: task.requestId, taskId, error: err });
    task.rejectId(err);
    task.rejectDone(err);
  }
}
