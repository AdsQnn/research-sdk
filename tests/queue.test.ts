import { LinkupClient, LinkupResearchQueue, type ResearchParams } from "../index";

/**
 * Live API test for LinkupResearchQueue.
 * Demonstrates batch + add, listen/unlisten, checkAll, and snapshots.
 * Run with: bun linkup_research_sdk_v2/tests/queue.test.ts
 */
const API_KEY = "API-KEY";
if (API_KEY === "API-KEY") {
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

const queue = new LinkupResearchQueue(client, {
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

const listener = queue.listen((evt) => {
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

const batchParams: ResearchParams[] = [
  {
    query: "Who are Linkup, the French AI startup, and who are the cofounders?",
    outputType: "sourcedAnswer",
  },
  {
    query: "Give me a one sentence summary of Linkup's mission.",
    outputType: "sourcedAnswer",
  },
];

const batchHandles = queue.batch(batchParams);

const addHandle1 = queue.add({
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
});

const addHandle2 = queue.add({
  query: "What is Linkup?",
  outputType: "sourcedAnswer",
});

const allHandles = [...batchHandles, addHandle1, addHandle2];
const requestIds = allHandles.map((h) => h.requestId);

// One live check (avoid repeated polling in tests).
await sleep(2500);
const entries = await queue.checkAll(requestIds);
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

const syncEntries = queue.checkAllSync(requestIds);
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

const active = queue.active();
const queued = queue.queued();
const allSnapshots = queue.all();

console.log(`active: ${active.map((entry) => entry.requestId).join(",") || "none"}`);
console.log(`queued: ${queued.map((entry) => entry.requestId).join(",") || "none"}`);
console.log(`all snapshots: ${allSnapshots.length}`);

const results = await queue.waitAll(allHandles);
listener.unlisten();

console.log("All done. Output types:");
for (const result of results) {
  const output = (result as Record<string, any>).output;
  console.log(`- ${output?.type ?? "unknown"}`);
}
