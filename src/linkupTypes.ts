export type LinkupOutputType = "sourcedAnswer" | "structured";

export type JsonSchemaTypeName = "null" | "boolean" | "object" | "array" | "number" | "integer" | "string";

export type JsonSchemaPrimitive = string | number | boolean | null;

export type JsonSchema = {
  $id?: string;
  $schema?: string;
  title?: string;
  description?: string;
  type?: JsonSchemaTypeName | JsonSchemaTypeName[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  enum?: JsonSchemaPrimitive[];
  const?: JsonSchemaPrimitive;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  not?: JsonSchema;
  [keyword: string]: unknown;
};

export type SourcedAnswerOutput = {
  type: "sourcedAnswer";
  [key: string]: unknown;
};

export type StructuredOutput<TStructured = unknown> = {
  type: "structured";
  data?: TStructured;
  [key: string]: unknown;
};

export type LinkupOutput<TStructured = unknown> = SourcedAnswerOutput | StructuredOutput<TStructured>;

export type LinkupStatus = "pending" | "processing" | "completed" | "error" | "unknown";

export interface LinkupStartResponse {
  id: string;
}

export interface LinkupResearchResponse<TOutput = LinkupOutput> {
  status?: LinkupStatus;
  output?: TOutput;
  [key: string]: unknown;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
  retryOnStatus?: number[];
}

export interface LinkupPollOptions<TOutput extends LinkupOutput = LinkupOutput> {
  pollIntervalMs?: number;
  timeoutMs?: number;
  retry?: RetryOptions;
  signal?: AbortSignal;
  onStatus?: (info: {
    attempt: number;
    status: LinkupStatus;
    response: LinkupResearchResponse<TOutput>;
    elapsedMs: number;
  }) => void;
}

export interface LinkupClientConfig {
  apiKey: string;
  baseUrl?: string;
  retry?: RetryOptions;
}

type ResearchParamsBase = {
  query: string;
  includeImages?: boolean;
  includeInlineCitations?: boolean;
  includeSources?: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
  fromDate?: Date | string;
  toDate?: Date | string;
  maxResults?: number;
  [key: string]: unknown;
};

export type SourcedAnswerParams = ResearchParamsBase & {
  outputType: "sourcedAnswer";
  structuredOutputSchema?: never;
};

export type StructuredResearchParams<TStructured = unknown> = ResearchParamsBase & {
  outputType: "structured";
  structuredOutputSchema: JsonSchema;
  __structuredOutput?: TStructured;
};

export type ResearchParams<TStructured = unknown> =
  | SourcedAnswerParams
  | StructuredResearchParams<TStructured>;

type StructuredOutputTypeFromParams<TParams> =
  TParams extends StructuredResearchParams<infer TStructured> ? TStructured : unknown;

export type ResearchOutputFor<TParams extends ResearchParams<any>> = TParams extends {
  outputType: "structured";
}
  ? StructuredOutput<StructuredOutputTypeFromParams<TParams>>
  : SourcedAnswerOutput;

export type LinkupResearchResponseFor<TParams extends ResearchParams<any>> =
  LinkupResearchResponse<ResearchOutputFor<TParams>>;
