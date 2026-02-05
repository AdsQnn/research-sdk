export type LinkupOutputType = "sourcedAnswer" | "structured";

export type LinkupStatus = "pending" | "processing" | "completed" | "error" | string;

export interface LinkupStartResponse {
  id: string;
}

export interface LinkupResearchResponse {
  status?: LinkupStatus;
  [key: string]: unknown;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
  retryOnStatus?: number[];
}

export interface LinkupPollOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  retry?: RetryOptions;
  onStatus?: (info: {
    attempt: number;
    status: LinkupStatus;
    response: LinkupResearchResponse;
    elapsedMs: number;
  }) => void;
}

export interface LinkupClientConfig {
  apiKey: string;
  baseUrl?: string;
  retry?: RetryOptions;
}

export interface ResearchParams {
  query: string;
  outputType: LinkupOutputType;
  structuredOutputSchema?: unknown;
  includeImages?: boolean;
  includeInlineCitations?: boolean;
  includeSources?: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
  fromDate?: Date | string;
  toDate?: Date | string;
  maxResults?: number;
  [key: string]: unknown;
}

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
  async search(params: ResearchParams) {
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
  async check(taskId: string, options: { retry?: RetryOptions } = {}) {
    const retry = options.retry ?? this.retry;
    const response = await fetchWithRetry(
      `${this.baseUrl}/research/${taskId}`,
      {
        headers: this.headers(false),
      },
      retry,
    );

    if (!response.ok) {
      throw new Error(
        `Linkup /research/${taskId} failed: ${response.status} ${response.statusText} - ${await readErrorBody(response)}`,
      );
    }

    return (await response.json()) as LinkupResearchResponse;
  }

  /**
   * Poll until completion. Emits optional onStatus callbacks.
   */
  async poll(taskId: string, options: LinkupPollOptions = {}) {
    const pollIntervalMs = options.pollIntervalMs ?? 2000;
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    const start = Date.now();
    let attempt = 0;

    while (true) {
      attempt += 1;
      const response = await this.check(taskId, { retry: options.retry });
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

      await sleep(pollIntervalMs);
    }
  }

  /**
   * Convenience: start + poll.
   */
  async searchAndWait(params: ResearchParams, options: LinkupPollOptions = {}) {
    const start = await this.search(params);
    const result = await this.poll(start.id, options);
    return { taskId: start.id, result };
  }

  private headers(withJson = true) {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      ...(withJson ? { "Content-Type": "application/json" } : {}),
    };
  }
}

const buildResearchPayload = (params: ResearchParams) => {
  const { query, outputType, ...rest } = params;
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
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const readErrorBody = async (response: Response) => {
  try {
    const text = await response.text();
    return text ? text.slice(0, 500) : "empty response";
  } catch (error) {
    return `unable to read error body: ${(error as Error).message}`;
  }
};

const retryableStatusesDefault = [408, 429, 500, 502, 503, 504];

const computeDelay = (attempt: number, baseDelayMs: number, maxDelayMs: number, jitter: number) => {
  const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const rand = 1 + (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(raw * rand));
};

const fetchWithRetry = async (url: string, init: RequestInit, retry?: RetryOptions) => {
  const maxAttempts = retry?.maxAttempts ?? 1;
  const baseDelayMs = retry?.baseDelayMs ?? 250;
  const maxDelayMs = retry?.maxDelayMs ?? 2000;
  const jitter = retry?.jitter ?? 0.2;
  const retryOnStatus = retry?.retryOnStatus ?? retryableStatusesDefault;

  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      const response = await fetch(url, init);
      if (response.ok) {
        return response;
      }

      if (attempt < maxAttempts && retryOnStatus.includes(response.status)) {
        response.body?.cancel();
        await sleep(computeDelay(attempt, baseDelayMs, maxDelayMs, jitter));
        continue;
      }

      return response;
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }
      await sleep(computeDelay(attempt, baseDelayMs, maxDelayMs, jitter));
    }
  }
};
