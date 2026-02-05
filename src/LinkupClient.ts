import type {
  LinkupClientConfig,
  LinkupOutput,
  LinkupPollOptions,
  LinkupResearchResponse,
  LinkupResearchResponseFor,
  LinkupStartResponse,
  ResearchOutputFor,
  ResearchParams,
  RetryOptions,
} from "./linkupTypes";

/**
 * Minimal client for Linkup /research endpoint.
 */
export class LinkupClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly retry?: RetryOptions;

  constructor(config: LinkupClientConfig) {
    if (!config?.apiKey) {
      throw new Error("Missing Linkup API key.");
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://api.linkup.so/v1").replace(/\/+$/, "");
    this.retry = config.retry;
  }

  /**
   * Start a /research task. Returns { id }.
   * For outputType "structured", provide structuredOutputSchema.
   */
  async search<TParams extends ResearchParams<any>>(params: TParams, options: { signal?: AbortSignal } = {}) {
    if (params.outputType === "structured") {
      const schema = params.structuredOutputSchema;
      if (!schema || typeof schema !== "object") {
        throw new Error("structuredOutputSchema must be a JSON schema object when outputType is 'structured'.");
      }
    }

    const payload = buildResearchPayload(params);
    const response = await fetch(`${this.baseUrl}/research`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: options.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Linkup /research failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`,
      );
    }

    const data = (await response.json()) as LinkupStartResponse;
    if (!data?.id) {
      throw new Error("Linkup /research did not return a task id.");
    }
    return data;
  }

  /**
   * Fetch status/result for a /research taskId.
   * Retries are applied only for transient errors (network or retryable status codes).
   */
  async check<TOutput extends LinkupOutput = LinkupOutput>(
    taskId: string,
    options: { retry?: RetryOptions; signal?: AbortSignal } = {},
  ) {
    const retry = options.retry ?? this.retry;
    const response = await fetchWithRetry(
      `${this.baseUrl}/research/${taskId}`,
      {
        headers: this.headers(false),
        signal: options.signal,
      },
      retry,
    );

    if (!response.ok) {
      throw new Error(
        `Linkup /research/${taskId} failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`,
      );
    }

    return (await response.json()) as LinkupResearchResponse<TOutput>;
  }

  /**
   * Poll until completion. Emits optional onStatus callbacks.
   */
  async poll<TOutput extends LinkupOutput = LinkupOutput>(taskId: string, options: LinkupPollOptions<TOutput> = {}) {
    const pollIntervalMs = options.pollIntervalMs ?? 2000;
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    const start = Date.now();
    let attempt = 0;

    while (true) {
      if (options.signal?.aborted) {
        throw createAbortError();
      }
      attempt += 1;
      const response = await this.check<TOutput>(taskId, { retry: options.retry, signal: options.signal });
      const status = response.status ?? "unknown";
      options.onStatus?.({
        attempt,
        status,
        response,
        elapsedMs: Date.now() - start,
      });

      if (status !== "pending" && status !== "processing" && status !== "unknown") {
        return response;
      }

      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for Linkup research result.`);
      }

      await sleep(pollIntervalMs, options.signal);
    }
  }

  /**
   * Convenience: start + poll.
   */
  async searchAndWait<TParams extends ResearchParams<any>>(
    params: TParams,
    options: LinkupPollOptions<ResearchOutputFor<TParams>> = {},
  ): Promise<{ taskId: string; result: LinkupResearchResponseFor<TParams> }> {
    const start = await this.search(params);
    const result = await this.poll<ResearchOutputFor<TParams>>(start.id, options);
    return { taskId: start.id, result };
  }

  private headers(withJson = true) {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      ...(withJson ? { "Content-Type": "application/json" } : {}),
    };
  }
}

function buildResearchPayload(params: ResearchParams) {
  const { query, outputType, __structuredOutput, ...rest } = params as ResearchParams & {
    __structuredOutput?: unknown;
  };
  const payload: Record<string, unknown> = {
    q: query,
    outputType,
  };

  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) {
      continue;
    }
    payload[key] = value instanceof Date ? value.toISOString() : value;
  }

  return payload;
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function readErrorBody(response: Response) {
  try {
    const text = await response.text();
    return text ? text.slice(0, 500) : "empty response";
  } catch (error) {
    return `unable to read error body: ${(error as Error).message}`;
  }
}

const retryableStatusesDefault = [408, 429, 500, 502, 503, 504];

function computeDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, jitter: number) {
  const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const rand = 1 + (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(raw * rand));
}

async function fetchWithRetry(url: string, init: RequestInit, retry?: RetryOptions) {
  const maxAttempts = retry?.maxAttempts ?? 1;
  const baseDelayMs = retry?.baseDelayMs ?? 250;
  const maxDelayMs = retry?.maxDelayMs ?? 2000;
  const jitter = retry?.jitter ?? 0.2;
  const retryOnStatus = retry?.retryOnStatus ?? retryableStatusesDefault;
  const signal = init.signal;

  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      if (signal?.aborted) {
        throw createAbortError();
      }
      const response = await fetch(url, init);
      if (response.ok) {
        return response;
      }

      if (attempt < maxAttempts && retryOnStatus.includes(response.status)) {
        response.body?.cancel();
        await sleep(computeDelay(attempt, baseDelayMs, maxDelayMs, jitter), signal);
        continue;
      }

      return response;
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        throw error;
      }
      if (attempt >= maxAttempts) {
        throw error;
      }
      await sleep(computeDelay(attempt, baseDelayMs, maxDelayMs, jitter), signal);
    }
  }
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
}

function createAbortError() {
  const err = new Error("Aborted");
  (err as Error & { name: string }).name = "AbortError";
  return err;
}
