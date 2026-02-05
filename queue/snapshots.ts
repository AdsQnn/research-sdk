import type { LinkupStatus } from "../LinkupClient";
import type { CheckAllEntry, QueueEvent } from "./types";

export class SnapshotStore {
  private readonly snapshots = new Map<number, CheckAllEntry>();
  private readonly taskIdToRequestId = new Map<string, number>();
  private readonly ttlMs?: number;
  private readonly maxEntries?: number;

  constructor(options: { ttlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
  }

  record(event: QueueEvent) {
    const now = Date.now();
    const entry: CheckAllEntry = {
      requestId: event.requestId,
      phase: event.type,
      updatedAt: now,
    };

    if ("taskId" in event && event.taskId) {
      entry.taskId = event.taskId;
      this.taskIdToRequestId.set(event.taskId, event.requestId);
    }

    if (event.type === "status") {
      entry.status = event.status;
      entry.response = event.response;
    } else if (event.type === "completed") {
      const status = (event.result as Record<string, unknown>)?.status;
      entry.status = typeof status === "string" ? (status as LinkupStatus) : "completed";
      entry.response = event.result;
    } else if (event.type === "error") {
      entry.error = event.error;
    }

    this.snapshots.set(event.requestId, entry);
    this.prune();
  }

  get(requestId: number) {
    return this.snapshots.get(requestId);
  }

  getAll() {
    return Array.from(this.snapshots.values());
  }

  getByTaskId(taskId: string) {
    const requestId = this.taskIdToRequestId.get(taskId);
    if (requestId === undefined) {
      return undefined;
    }
    return this.snapshots.get(requestId);
  }

  getRequestId(taskId: string) {
    return this.taskIdToRequestId.get(taskId);
  }

  update(entry: CheckAllEntry) {
    const updated = {
      ...entry,
      updatedAt: entry.updatedAt ?? Date.now(),
    };
    this.snapshots.set(updated.requestId, updated);
    if (updated.taskId) {
      this.taskIdToRequestId.set(updated.taskId, updated.requestId);
    }
    this.prune();
  }

  private prune() {
    if (this.ttlMs) {
      const cutoff = Date.now() - this.ttlMs;
      for (const [requestId, snapshot] of this.snapshots.entries()) {
        const updatedAt = snapshot.updatedAt ?? 0;
        if (updatedAt < cutoff) {
          this.snapshots.delete(requestId);
        }
      }
    }

    if (this.maxEntries && this.snapshots.size > this.maxEntries) {
      const entries = Array.from(this.snapshots.entries());
      entries.sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0));
      const toRemove = entries.length - this.maxEntries;
      for (let i = 0; i < toRemove; i += 1) {
        this.snapshots.delete(entries[i][0]);
      }
    }
  }
}
