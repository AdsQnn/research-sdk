import type {
  LinkupOutput,
  LinkupPollOptions,
  LinkupResearchResponse,
  LinkupStatus,
  ResearchParams,
} from "../LinkupClient";

export type QueueEvent<TOutput = LinkupOutput> =
  | {
      type: "enqueued";
      requestId: number;
      params: ResearchParams;
    }
  | {
      type: "started";
      requestId: number;
      taskId: string;
      params: ResearchParams;
    }
  | {
      type: "status";
      requestId: number;
      taskId: string;
      status: LinkupStatus;
      response: LinkupResearchResponse<TOutput>;
      elapsedMs: number;
    }
  | {
      type: "completed";
      requestId: number;
      taskId: string;
      result: LinkupResearchResponse<TOutput>;
    }
  | {
      type: "error";
      requestId: number;
      taskId?: string;
      error: Error;
    };

export interface QueueHandle<TOutput = LinkupOutput> {
  requestId: number;
  id: Promise<string>;
  done: Promise<LinkupResearchResponse<TOutput>>;
}

export interface QueueOptions<TOutput = LinkupOutput> extends LinkupPollOptions<TOutput> {
  concurrency?: number;
  snapshotTtlMs?: number | null;
  snapshotMaxEntries?: number | null;
  checkConcurrency?: number;
}

export type CheckAllEntry<TOutput = LinkupOutput> = {
  requestId: number;
  taskId?: string;
  status?: LinkupStatus;
  response?: LinkupResearchResponse<TOutput>;
  error?: Error;
  notTracked?: boolean;
  phase?: "enqueued" | "started" | "status" | "completed" | "error";
  updatedAt?: number;
};

export type ActiveEntry = {
  requestId: number;
  taskId?: string;
  params: ResearchParams;
};

export type QueuedEntry = {
  requestId: number;
  params: ResearchParams;
};

export type ListenerHandle = {
  unlisten: () => void;
};
