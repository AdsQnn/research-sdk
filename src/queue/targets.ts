import type { ResearchParams } from "../linkupTypes";
import type { QueueState } from "./state";
import type { SnapshotStore } from "./snapshots";
import type { CheckTarget } from "./checks";

export const collectTargets = <TParams extends ResearchParams<any>>(
  requestIds: number[] | undefined,
  state: QueueState<TParams>,
) => {
  const filter = requestIds ? new Set(requestIds) : undefined;
  const targets: CheckTarget[] = [];

  if (filter) {
    for (const requestId of filter) {
      const taskId = state.getTaskId(requestId);
      targets.push({ requestId, taskId });
    }
    return targets;
  }

  for (const [requestId, activeTask] of state.entriesActive()) {
    targets.push({ requestId, taskId: activeTask.taskId });
  }

  return targets;
};

export const collectTargetsByTaskId = <TParams extends ResearchParams<any>>(
  taskIds: string[] | undefined,
  state: QueueState<TParams>,
  snapshots: SnapshotStore<TParams>,
) => {
  const targets: CheckTarget[] = [];
  if (!taskIds) {
    for (const [requestId, activeTask] of state.entriesActive()) {
      targets.push({ requestId, taskId: activeTask.taskId });
    }
    return targets;
  }

  for (const taskId of taskIds) {
    const requestId = snapshots.getRequestId(taskId);
    if (requestId === undefined) {
      targets.push({ requestId: -1, taskId });
      continue;
    }
    targets.push({ requestId, taskId });
  }

  return targets;
};
