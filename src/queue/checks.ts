import type { CheckAllEntry } from "./types";
import type { LinkupClient } from "../LinkupClient";
import type { ResearchOutputFor, ResearchParams, RetryOptions } from "../linkupTypes";
import type { SnapshotStore } from "./snapshots";

export type CheckTarget = { requestId: number; taskId?: string };

export const runCheckAll = async <TParams extends ResearchParams<any> = ResearchParams>(
  targets: CheckTarget[],
  client: LinkupClient,
  snapshots: SnapshotStore<TParams>,
  retry?: RetryOptions,
  checkConcurrency?: number,
) => {
  const runCheck = async (target: CheckTarget) => {
    if (!target.taskId) {
      return { requestId: target.requestId, notTracked: true } as CheckAllEntry<TParams>;
    }
    try {
      const response = await client.check<ResearchOutputFor<TParams>>(target.taskId, { retry });
      const entry: CheckAllEntry<TParams> = {
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
      const entry: CheckAllEntry<TParams> = {
        requestId: target.requestId,
        taskId: target.taskId,
        error: err,
        phase: "error",
        updatedAt: Date.now(),
      };
      snapshots.update(entry);
      return entry;
    }
  };

  if (!checkConcurrency || checkConcurrency <= 0 || checkConcurrency >= targets.length) {
    return await Promise.all(targets.map((target) => runCheck(target)));
  }

  const results: CheckAllEntry<TParams>[] = new Array(targets.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(checkConcurrency, targets.length) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= targets.length) {
        return;
      }
      results[current] = await runCheck(targets[current]);
    }
  });

  await Promise.all(workers);
  return results;
};
