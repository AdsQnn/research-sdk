import type { CheckAllEntry } from "./types";
import type { LinkupClient, RetryOptions } from "../LinkupClient";
import type { SnapshotStore } from "./snapshots";

export type CheckTarget = { requestId: number; taskId?: string };

export const runCheckAll = async (
  targets: CheckTarget[],
  client: LinkupClient,
  snapshots: SnapshotStore,
  retry?: RetryOptions,
) => {
  const checks = targets.map(async (target) => {
    if (!target.taskId) {
      return { requestId: target.requestId, notTracked: true } as CheckAllEntry;
    }
    try {
      const response = await client.check(target.taskId, { retry });
      const entry: CheckAllEntry = {
        requestId: target.requestId,
        taskId: target.taskId,
        status: response.status,
        response,
        phase: "status",
        updatedAt: Date.now(),
      };
      snapshots.update(entry);
      return entry;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const entry: CheckAllEntry = {
        requestId: target.requestId,
        taskId: target.taskId,
        error: err,
        phase: "error",
        updatedAt: Date.now(),
      };
      snapshots.update(entry);
      return entry;
    }
  });

  return await Promise.all(checks);
};
