import { LinkupClient, LinkupResearchQueue, type SourcedAnswerParams, type StructuredResearchParams } from "../src/index";

/**
 * Live API test for LinkupResearchQueue.
 * Demonstrates batch + add, listen/unlisten, checkAll, and snapshots.
 * Run with: bun linkup_research_sdk_v2/tests/queue.test.ts
 */
const API_KEY = "API_KEY";
if (API_KEY === "API_KEY") {
  throw new Error("Set API_KEY in tests/queue.test.ts before running.");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const client = new LinkupClient({
  apiKey: API_KEY,
  retry: {
    maxAttempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 2000,
    jitter: 0.2,
  },
});

type StructuredResult = {
  company: string;
  founders: string[];
};

type StructuredParams = StructuredResearchParams<StructuredResult>;

const sourcedQueue = new LinkupResearchQueue<SourcedAnswerParams>(client, {
  concurrency: 2,
  pollIntervalMs: 2000,
  snapshotTtlMs: 10 * 60 * 1000,
  snapshotMaxEntries: 200,
  retry: {
    maxAttempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 2000,
    jitter: 0.2,
  },
});

const structuredQueue = new LinkupResearchQueue<StructuredParams>(client, {
  concurrency: 2,
  pollIntervalMs: 2000,
  retry: {
    maxAttempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 2000,
    jitter: 0.2,
  },
});

const listener = sourcedQueue.listen((evt) => {
  if (evt.type === "enqueued") {
    console.log(`[enqueued] requestId=${evt.requestId}`);
  }
  if (evt.type === "started") {
    console.log(`[started] requestId=${evt.requestId} taskId=${evt.taskId}`);
  }
  if (evt.type === "status") {
    console.log(`[status] requestId=${evt.requestId} ${evt.status}`);
  }
  if (evt.type === "completed") {
    console.log(`[completed] requestId=${evt.requestId}`);
  }
  if (evt.type === "error") {
    console.log(`[error] requestId=${evt.requestId} ${evt.error.message}`);
  }
});

const batchParams: SourcedAnswerParams[] = [
  {
    query: "Who are Linkup, the French AI startup, and who are the cofounders?",
    outputType: "sourcedAnswer",
  },
  {
    query: "Give me a one sentence summary of Linkup's mission.",
    outputType: "sourcedAnswer",
  },
];

const batchHandles = sourcedQueue.batch(batchParams);

const structuredParams: StructuredParams = {
  query: "Return JSON with fields: company, founders. Keep values short.",
  outputType: "structured",
  // The live API currently expects a JSON schema for structured output.
  structuredOutputSchema: {
    type: "object",
    properties: {
      company: { type: "string" },
      founders: { type: "array", items: { type: "string" } },
    },
    required: ["company", "founders"],
    additionalProperties: false,
  },
};

const structuredHandle = structuredQueue.add(structuredParams);

const addHandle2 = sourcedQueue.add({
  query: "What is Linkup?",
  outputType: "sourcedAnswer",
});

const sourcedHandles = [...batchHandles, addHandle2];
const requestIds = sourcedHandles.map((h) => h.requestId);

// One live check (avoid repeated polling in tests).
await sleep(2500);
const entries = await sourcedQueue.checkAll(requestIds);
console.log("checkAll (async):");
for (const entry of entries) {
  if (entry.notTracked) {
    console.log(`- requestId=${entry.requestId} notTracked`);
  } else if (entry.error) {
    console.log(`- requestId=${entry.requestId} error=${entry.error.message}`);
  } else {
    console.log(`- requestId=${entry.requestId} status=${entry.status ?? "unknown"}`);
  }
}

const syncEntries = sourcedQueue.checkAllSync(requestIds);
console.log("checkAllSync:");
for (const entry of syncEntries) {
  if (entry.notTracked) {
    console.log(`- requestId=${entry.requestId} notTracked`);
  } else if (entry.error) {
    console.log(`- requestId=${entry.requestId} error=${entry.error.message}`);
  } else {
    console.log(`- requestId=${entry.requestId} status=${entry.status ?? "unknown"}`);
  }
}

const active = sourcedQueue.active();
const queued = sourcedQueue.queued();
const allSnapshots = sourcedQueue.all();

console.log(`active: ${active.map((entry) => entry.requestId).join(",") || "none"}`);
console.log(`queued: ${queued.map((entry) => entry.requestId).join(",") || "none"}`);
console.log(`all snapshots: ${allSnapshots.length}`);

const sourcedResults = await sourcedQueue.waitAll(sourcedHandles);
const structuredResults = await structuredQueue.waitAll([structuredHandle]);
listener.unlisten();

console.log("Sourced outputs:");
for (const result of sourcedResults) {
  console.log(`- ${result.output?.type ?? "unknown"}`);
}

console.log("Structured outputs:");
for (const result of structuredResults) {
  console.log(`- ${result.output?.type ?? "unknown"}`);
}
