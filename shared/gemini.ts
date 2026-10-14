// Google Gemini REST adapter: generation, function calling, JSON mode, embeddings.
// Depends only on an injected `fetch`, so it runs on Cloudflare Workers and Node alike.

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const EMBED_BATCH_SIZE = 100;
const MAX_RETRY_WAIT_MS = 60_000;

/** Must match the `vector(768)` columns in supabase/schema.sql. */
export const EMBEDDING_DIMENSIONS = 768;

export interface GeminiConfig {
  apiKey: string;
  model: string;
  embeddingModel: string;
  /** Retries on 429/5xx. Keep low inside request handlers, higher in batch jobs. */
  maxRetries: number;
}

export interface GeminiDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

export type SchemaType = "OBJECT" | "ARRAY" | "STRING" | "INTEGER" | "NUMBER" | "BOOLEAN";

export interface Schema {
  type: SchemaType;
  description?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: string[];
  required?: string[];
  nullable?: boolean;
}

export interface FunctionCall {
  name: string;
  args?: Record<string, unknown>;
  id?: string;
}

export interface Part {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: FunctionCall;
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
}

export interface Content {
  role: "user" | "model";
  parts: Part[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: Schema;
}

export interface GenerateOptions {
  system: string;
  contents: Content[];
  temperature: number;
  tools?: FunctionDeclaration[];
  /** "NONE" forbids tool calls while keeping declarations (needed when history contains calls). */
  toolMode?: "AUTO" | "NONE";
}

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

interface GenerateResponse {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

export class Gemini {
  constructor(
    private readonly config: GeminiConfig,
    private readonly deps: GeminiDeps,
  ) {}

  async generate(opts: GenerateOptions): Promise<Content> {
    return this.generateWith(opts, { temperature: opts.temperature });
  }

  /** Generates a response constrained to `schema`, then narrows it with `parse`. */
  async generateJson<T>(
    opts: Omit<GenerateOptions, "tools" | "toolMode">,
    schema: Schema,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const content = await this.generateWith(opts, {
      temperature: opts.temperature,
      responseMimeType: "application/json",
      responseSchema: schema,
    });
    const text = textOf(content);
    let value: unknown;
    try {
      value = JSON.parse(stripCodeFence(text));
    } catch {
      throw new GeminiError(`Gemini returned invalid JSON: ${text.slice(0, 300)}`, null);
    }
    return parse(value);
  }

  /** Embeddings for content that will be stored and searched. */
  embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(texts, "RETRIEVAL_DOCUMENT");
  }

  /** Embeddings for search queries against code. */
  embedQueries(texts: string[]): Promise<number[][]> {
    return this.embed(texts, "CODE_RETRIEVAL_QUERY");
  }

  private async generateWith(
    opts: Omit<GenerateOptions, "temperature">,
    generationConfig: Record<string, unknown>,
  ): Promise<Content> {
    const body: Record<string, unknown> = {
      contents: opts.contents,
      generationConfig,
      systemInstruction: { parts: [{ text: opts.system }] },
    };
    if (opts.tools?.length) {
      body.tools = [{ functionDeclarations: opts.tools }];
      body.toolConfig = { functionCallingConfig: { mode: opts.toolMode ?? "AUTO" } };
    }

    // Cast once at the edge: the response shape is Google's documented contract.
    const data = (await this.call(`models/${this.config.model}:generateContent`, body)) as GenerateResponse;
    const candidate = data.candidates?.[0];
    if (!candidate?.content) {
      const reason = data.promptFeedback?.blockReason ?? candidate?.finishReason ?? "no candidates";
      throw new GeminiError(`Gemini returned no content (${reason})`, null);
    }
    return { role: "model", parts: candidate.content.parts ?? [] };
  }

  private async embed(texts: string[], taskType: "RETRIEVAL_DOCUMENT" | "CODE_RETRIEVAL_QUERY"): Promise<number[][]> {
    const model = this.config.embeddingModel;
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
      const data = (await this.call(`models/${model}:batchEmbedContents`, {
        requests: batch.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: EMBEDDING_DIMENSIONS,
        })),
      })) as { embeddings?: { values?: number[] }[] };

      const embeddings = data.embeddings ?? [];
      if (embeddings.length !== batch.length) {
        throw new GeminiError(`Expected ${batch.length} embeddings, got ${embeddings.length}`, null);
      }
      // Truncated (768-dim) Gemini embeddings are not normalised by the API.
      for (const e of embeddings) vectors.push(normalize(e.values ?? []));
    }
    return vectors;
  }

  private async call(path: string, body: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.deps.fetch(`${API_BASE}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.config.apiKey },
        body: JSON.stringify(body),
      });
      if (res.ok) return (await res.json()) as unknown;

      const text = await res.text();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.config.maxRetries) {
        throw new GeminiError(`Gemini API ${res.status}: ${text.slice(0, 500)}`, res.status);
      }
      await this.deps.sleep(retryDelayMs(text, attempt));
    }
  }
}

export function textOf(content: Content): string {
  return content.parts
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join("")
    .trim();
}

export function functionCallsOf(content: Content): FunctionCall[] {
  return content.parts.flatMap((p) => (p.functionCall ? [p.functionCall] : []));
}

/** Honors the server's RetryInfo hint when present, otherwise exponential backoff. */
function retryDelayMs(errorBody: string, attempt: number): number {
  const hint = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(errorBody);
  const hinted = hint?.[1] ? Math.ceil(parseFloat(hint[1]) * 1000) : 0;
  return Math.min(Math.max(hinted, 1000 * 2 ** attempt), MAX_RETRY_WAIT_MS);
}

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function stripCodeFence(text: string): string {
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim());
  return m?.[1] ?? text;
}
