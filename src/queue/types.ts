import type { LinkupPollOptions, LinkupResearchResponse, LinkupStatus, ResearchParams } from "../LinkupClient";

export type QueueEvent =
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
      response: LinkupResearchResponse;
      elapsedMs: number;
    }
  | {
      type: "completed";
      requestId: number;
      taskId: string;
      result: LinkupResearchResponse;
    }
  | {
      type: "error";
      requestId: number;
      taskId?: string;
      error: Error;
    };

export interface QueueHandle {
  requestId: number;
  id: Promise<string>;
  done: Promise<LinkupResearchResponse>;
}

export interface QueueOptions extends LinkupPollOptions {
  concurrency?: number;
  snapshotTtlMs?: number | null;
  snapshotMaxEntries?: number | null;
  checkConcurrency?: number;
}

export type CheckAllEntry = {
  requestId: number;
  taskId?: string;
  status?: LinkupStatus;
  response?: LinkupResearchResponse;
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
