import { LinkupClient, type ResearchOutputFor, type SourcedAnswerParams } from "../src/index";

/**
 * Live API test for LinkupClient.
 * Run with: bun linkup_research_sdk_v2/tests/client.test.ts
 */
const API_KEY = "API_KEY";
if (API_KEY === "API_KEY") {
  throw new Error("Set API_KEY in tests/client.test.ts before running.");
}

const client = new LinkupClient({
  apiKey: API_KEY,
  retry: {
    maxAttempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 2000,
    jitter: 0.2,
  },
});

const query = "Who are Linkup, the French AI startup? Answer in 2 sentences.";

const params: SourcedAnswerParams = {
  query,
  outputType: "sourcedAnswer",
};

const { id } = await client.search(params);

console.log(`[client] taskId=${id}`);

type Output = ResearchOutputFor<typeof params>;

const first = await client.check<Output>(id);
console.log(`[client] check status=${first.status ?? "unknown"}`);

const result = await client.poll<Output>(id, {
  pollIntervalMs: 2000,
  retry: {
    maxAttempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 2000,
    jitter: 0.2,
  },
  onStatus: ({ status, attempt, response }) => {
    console.log(`[client poll ${attempt}] status=${status}`);
    if (status === "pending" || status === "processing") {
      console.dir(response, { depth: null });
    }
  },
});

console.log(`[client] final status=${result.status ?? "unknown"}`);
console.dir(result, { depth: null });
