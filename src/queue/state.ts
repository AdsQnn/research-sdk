import type { LinkupOutput, LinkupResearchResponse, ResearchParams } from "../LinkupClient";
import type { ActiveEntry, QueuedEntry } from "./types";

export type QueueTask = {
  requestId: number;
  params: ResearchParams;
  resolveId: (id: string) => void;
  rejectId: (error: Error) => void;
  resolveDone: (result: LinkupResearchResponse<LinkupOutput>) => void;
  rejectDone: (error: Error) => void;
};

export type ActiveTask = {
  task: QueueTask;
  taskId?: string;
};

export class QueueState {
  private readonly tasks: QueueTask[] = [];
  private readonly queued = new Map<number, QueueTask>();
  private readonly active = new Map<number, ActiveTask>();

  enqueue(task: QueueTask) {
    this.tasks.push(task);
    this.queued.set(task.requestId, task);
  }

  take(count: number) {
    const toStart = this.tasks.splice(0, count);
    for (const task of toStart) {
      this.queued.delete(task.requestId);
      this.active.set(task.requestId, { task });
    }
    return toStart;
  }

  setTaskId(requestId: number, taskId: string) {
    const activeTask = this.active.get(requestId);
    if (activeTask) {
      activeTask.taskId = taskId;
    }
  }

  getActive(requestId: number) {
    return this.active.get(requestId);
  }

  getTaskId(requestId: number) {
    return this.active.get(requestId)?.taskId;
  }

  removeActive(requestId: number) {
    this.active.delete(requestId);
  }

  listActive(): ActiveEntry[] {
    const entries: ActiveEntry[] = [];
    for (const [requestId, activeTask] of this.active.entries()) {
      if (!activeTask.taskId) {
        continue;
      }
      entries.push({
        requestId,
        taskId: activeTask.taskId,
        params: activeTask.task.params,
      });
    }
    return entries;
  }

  listQueued(): QueuedEntry[] {
    const entries: QueuedEntry[] = [];
    for (const [requestId, task] of this.queued.entries()) {
      entries.push({ requestId, params: task.params });
    }
    return entries;
  }

  removeQueued(requestId: number) {
    const task = this.queued.get(requestId);
    if (!task) {
      return undefined;
    }
    this.queued.delete(requestId);
    const index = this.tasks.findIndex((entry) => entry.requestId === requestId);
    if (index >= 0) {
      this.tasks.splice(index, 1);
    }
    return task;
  }

  findRequestIdByTaskId(taskId: string) {
    for (const [requestId, activeTask] of this.active.entries()) {
      if (activeTask.taskId === taskId) {
        return requestId;
      }
    }
    return undefined;
  }

  entriesActive() {
    return this.active.entries();
  }

  drainAll() {
    const queuedTasks = Array.from(this.queued.values());
    const activeTasks = Array.from(this.active.values());
    this.tasks.length = 0;
    this.queued.clear();
    this.active.clear();
    return { queuedTasks, activeTasks };
  }
}
