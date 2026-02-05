# Linkup /research SDK

Minimal TypeScript client + queue wrapper for the Linkup `/research` endpoint.
Designed to be simple to read and easy to extend.

## What’s included

- `LinkupClient` — direct `/research` calls (start, check, poll)
- `LinkupResearchQueue` — batching, polling, snapshots, and event listening
- Live API tests you can run directly

## Requirements

- A Linkup API key

Set it in the test files by replacing `API-KEY`.

## Usage

Import from the barrel `src/index.ts`:

```ts
import { LinkupClient, LinkupResearchQueue } from "./src/index";
```

## Output types

`/research` supports only:

- `sourcedAnswer`
- `structured` (requires `structuredOutputSchema` JSON schema object)

Note: `/research` does **not** support `depth`.
The live API currently validates `structuredOutputSchema` for `structured` output.

## Supported parameters (ResearchParams)

`/research` accepts the same parameters as `/search` except `depth`:

- `query` (string) → sent as `q`
- `outputType` (`sourcedAnswer` | `structured`)
- `structuredOutputSchema` (JSON schema, required for `structured`)
- `includeImages` (boolean)
- `includeInlineCitations` (boolean)
- `includeSources` (boolean)
- `includeDomains` (string[])
- `excludeDomains` (string[])
- `fromDate` (Date | ISO string)
- `toDate` (Date | ISO string)
- `maxResults` (number)

Additional fields are passed through as-is.

## Examples

### 1) Start → check → poll (client)

```ts
import { LinkupClient } from "./src/index";

const API_KEY = "API-KEY";
const client = new LinkupClient({ apiKey: API_KEY });

const { id } = await client.search({
  query: "Who are Linkup, the French AI startup?",
  outputType: "sourcedAnswer",
  includeInlineCitations: false,
});

const first = await client.check(id);
console.log(first.status);

const final = await client.poll(id, {
  pollIntervalMs: 2000,
  onStatus: ({ status }) => console.log(status),
});

console.dir(final, { depth: null });
```

### 2) Queue batch + add (list of requests)

```ts
import { LinkupClient, LinkupResearchQueue, type ResearchParams } from "./src/index";

const API_KEY = "API-KEY";
const client = new LinkupClient({ apiKey: API_KEY });
const queue = new LinkupResearchQueue(client, { concurrency: 2, pollIntervalMs: 2000 });

const batch: ResearchParams[] = [
  { query: "Who are Linkup, the French AI startup?", outputType: "sourcedAnswer" },
  { query: "Give one sentence on Linkup's mission.", outputType: "sourcedAnswer" },
];

const batchHandles = queue.batch(batch);

const singleHandle = queue.add({
  query: "Return JSON with fields: company, founders.",
  outputType: "structured",
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

const results = await queue.waitAll([...batchHandles, singleHandle]);
console.log(results.length);
```

### 3) Listen to queue events

```ts
const listener = queue.listen((evt) => {
  if (evt.type === "started") {
    console.log(evt.requestId, evt.taskId);
  }
  if (evt.type === "status") {
    console.log(evt.requestId, evt.status);
  }
});

// later:
listener.unlisten();
```

## Retry/backoff

You can enable retry for transient errors on `check/poll`:

```ts
const client = new LinkupClient({
  apiKey: API_KEY,
  retry: {
    maxAttempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 2000,
    jitter: 0.2,
  },
});
```

Queue can also pass retry options via `QueueOptions`:

```ts
const queue = new LinkupResearchQueue(client, {
  pollIntervalMs: 2000,
  retry: {
    maxAttempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 2000,
    jitter: 0.2,
  },
});
```

## Snapshot retention

By default the queue keeps snapshots for 1 hour and caps at 1000 entries.
You can override or disable the limits:

```ts
const queue = new LinkupResearchQueue(client, {
  snapshotTtlMs: 10 * 60 * 1000, // keep 10 minutes
  snapshotMaxEntries: 200,       // cap memory
});
```

Disable pruning entirely:

```ts
const queue = new LinkupResearchQueue(client, {
  snapshotTtlMs: null,
  snapshotMaxEntries: null,
});
```

## checkAll concurrency

Limit parallel GETs for `checkAll`/`checkAllByTaskId`:

```ts
const queue = new LinkupResearchQueue(client, {
  checkConcurrency: 4,
});
```

## Queue API (core)

- `add(params)` — enqueue one request
- `batch(params[])` — enqueue many
- `listen(fn)` — listen to events (returns handle with `unlisten()`)
- `active()` — active tasks with taskId
- `queued()` — tasks waiting to start
- `all()` — snapshot list (queued/active/completed/error)
- `check(requestId)` — live GET for one task
- `checkAll()` — live GET for all active tasks
- `stop()` — stops the queue and rejects pending handles with `Error("Queue stopped")`
- `cancel(requestId)` — aborts local polling and rejects that handle
- `cancelByTaskId(taskId)` — same but by Linkup taskId

## AbortSignal support

`LinkupClient.search`, `check`, and `poll` accept `AbortSignal`:

```ts
const controller = new AbortController();
const { id } = await client.search(
  { query: "Example", outputType: "sourcedAnswer" },
  { signal: controller.signal },
);

// later:
controller.abort();
```

Queue cancellation uses AbortSignal internally to stop local polling.

## Compatibility note

`Promise.withResolvers` is not used (Node 18 compatible).

## Folder structure

```
linkup_research_sdk_v2/
  package.json
  .gitignore
  src/
    LinkupClient.ts
    LinkupResearchQueue.ts
    index.ts
    queue/
      types.ts
      engine.ts
      deferred.ts
      state.ts
      snapshots.ts
      targets.ts
      checks.ts
  tests/
    client.test.ts
    queue.test.ts
```

## Notes

- `requestId` is local (queue-generated)
- `taskId` is from the Linkup API (`/research` response)
- `listen` receives both ids so you can correlate

## Tests (live API)

These are simple runnable scripts (no CLI args):

```bash
bun tests/client.test.ts
bun tests/queue.test.ts
```

They call the live API, so run sparingly.
