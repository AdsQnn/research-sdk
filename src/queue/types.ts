import type {
  LinkupPollOptions,
  LinkupResearchResponse,
  LinkupStatus,
  ResearchOutputFor,
  ResearchParams,
} from "../linkupTypes";

export type QueueEvent<TParams extends ResearchParams<any> = ResearchParams> =
  | {
      type: "enqueued";
      requestId: number;
      params: TParams;
    }
  | {
      type: "started";
      requestId: number;
      taskId: string;
      params: TParams;
    }
  | {
      type: "status";
      requestId: number;
      taskId: string;
      status: LinkupStatus;
      response: LinkupResearchResponse<ResearchOutputFor<TParams>>;
      elapsedMs: number;
    }
  | {
      type: "completed";
      requestId: number;
      taskId: string;
      result: LinkupResearchResponse<ResearchOutputFor<TParams>>;
    }
  | {
      type: "error";
      requestId: number;
      taskId?: string;
      error: Error;
    };

export interface QueueHandle<TParams extends ResearchParams<any> = ResearchParams> {
  requestId: number;
  id: Promise<string>;
  done: Promise<LinkupResearchResponse<ResearchOutputFor<TParams>>>;
}

export interface QueueOptions<TParams extends ResearchParams<any> = ResearchParams>
  extends LinkupPollOptions<ResearchOutputFor<TParams>> {
  concurrency?: number;
  snapshotTtlMs?: number | null;
  snapshotMaxEntries?: number | null;
  checkConcurrency?: number;
}

export type CheckAllEntry<TParams extends ResearchParams<any> = ResearchParams> = {
  requestId: number;
  taskId?: string;
  status?: LinkupStatus;
  response?: LinkupResearchResponse<ResearchOutputFor<TParams>>;
  error?: Error;
  notTracked?: boolean;
  phase?: "enqueued" | "started" | "status" | "completed" | "error";
  updatedAt?: number;
};

export type ActiveEntry<TParams extends ResearchParams<any> = ResearchParams> = {
  requestId: number;
  taskId?: string;
  params: TParams;
};

export type QueuedEntry<TParams extends ResearchParams<any> = ResearchParams> = {
  requestId: number;
  params: TParams;
};

export type ListenerHandle = {
  unlisten: () => void;
};
