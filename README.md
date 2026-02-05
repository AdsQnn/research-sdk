# Linkup /research SDK (v2)

Minimal TypeScript client + queue wrapper for the Linkup `/research` endpoint.
Designed to be simple to read and easy to extend.

## What’s included

- `LinkupClient` — direct `/research` calls (start, check, poll)
- `LinkupResearchQueue` — batching, polling, snapshots, and event listening
- Examples you can run directly (no CLI args required)

## Requirements

- A Linkup API key

Set it in the test files by replacing `API-KEY`.

## Usage

Import from the barrel `index.ts`:

```ts
import { LinkupClient, LinkupResearchQueue } from "./index";
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

## Retry/backoff

You can enable retry for transient errors on `check/poll`:

```ts
const client = new LinkupClient({
  apiKey: apiConfig.api_key,
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

Optional pruning for snapshots:

```ts
const queue = new LinkupResearchQueue(client, {
  snapshotTtlMs: 10 * 60 * 1000, // keep 10 minutes
  snapshotMaxEntries: 200,       // cap memory
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

## Folder structure

```
linkup_research_sdk_v2/
  package.json
  .gitignore
  LinkupClient.ts
  LinkupResearchQueue.ts
  queue/
    types.ts
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
bun linkup_research_sdk_v2/tests/client.test.ts
bun linkup_research_sdk_v2/tests/queue.test.ts
```

They call the live API, so run sparingly.
