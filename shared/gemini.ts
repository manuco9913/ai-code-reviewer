// Google Gemini REST adapter: generation, function calling, JSON mode, embeddings.
// Depends only on an injected `fetch`, so it runs on Cloudflare Workers and Node alike.

import { isTimeout } from "./net";

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
  /** Tried in order when `model` stays overloaded (free-tier capacity varies by model). */
  fallbackModels: string[];
  /** Gemini 3 thinking depth ("low" answers much faster); null keeps the model's default. */
  thinkingLevel: "low" | "medium" | "high" | null;
  /** Embedding texts sent per rolling minute; batches wait rather than exceed it. */
  embedTextsPerMinute: number;
}

export interface GeminiDeps {
  /** Should carry a deadline (see fetchWithTimeout); timeouts are retried. */
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Receives retry notices, including the quota Gemini says was exceeded. */
  log: (message: string) => void;
  /** Milliseconds clock, for embedding pacing. */
  now: () => number;
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
  /** Embedding sends within the last minute, for pacing. */
  private recentEmbeds: { at: number; count: number }[] = [];

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
      generationConfig: this.config.thinkingLevel
        ? { ...generationConfig, thinkingConfig: { thinkingLevel: this.config.thinkingLevel } }
        : generationConfig,
      systemInstruction: { parts: [{ text: opts.system }] },
    };
    if (opts.tools?.length) {
      body.tools = [{ functionDeclarations: opts.tools }];
      body.toolConfig = { functionCallingConfig: { mode: opts.toolMode ?? "AUTO" } };
    }

    // Cast once at the edge: the response shape is Google's documented contract.
    const data = (await this.generateWithFallback(body)) as GenerateResponse;
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
    const batchSize = Math.max(1, Math.min(EMBED_BATCH_SIZE, this.config.embedTextsPerMinute));
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      await this.waitForEmbedBudget(batch.length);
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

  /**
   * Tries the configured model, then each fallback, moving on only when a model stays overloaded
   * (429/5xx/timeout after its retries). Request errors (4xx) fail immediately.
   */
  private async generateWithFallback(body: unknown): Promise<unknown> {
    const models = [this.config.model, ...this.config.fallbackModels];
    for (const [i, model] of models.entries()) {
      try {
        return await this.call(`models/${model}:generateContent`, body);
      } catch (err) {
        const next = models[i + 1];
        const overloaded = isTimeout(err) || (err instanceof GeminiError && (err.status === 429 || (err.status ?? 0) >= 500));
        if (!next || !overloaded) throw err;
        this.deps.log(`Gemini model ${model} unavailable (${err instanceof Error ? err.message.slice(0, 120) : err}); trying ${next}`);
      }
    }
    throw new GeminiError("No Gemini model configured", null);
  }

  private async waitForEmbedBudget(count: number): Promise<void> {
    for (;;) {
      const now = this.deps.now();
      this.recentEmbeds = this.recentEmbeds.filter((e) => e.at > now - 60_000);
      const used = this.recentEmbeds.reduce((n, e) => n + e.count, 0);
      const oldest = this.recentEmbeds[0];
      if (used + count <= this.config.embedTextsPerMinute || !oldest) {
        this.recentEmbeds.push({ at: now, count });
        return;
      }
      await this.deps.sleep(oldest.at + 60_000 - now);
    }
  }

  private async call(path: string, body: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const lastAttempt = attempt >= this.config.maxRetries;
      let res: Response;
      try {
        res = await this.deps.fetch(`${API_BASE}/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.config.apiKey },
          body: JSON.stringify(body),
        });
      } catch (err) {
        if (!isTimeout(err) || lastAttempt) throw err;
        const wait = retryDelayMs("", attempt);
        this.deps.log(`Gemini request timed out; retrying in ${Math.round(wait / 1000)}s`);
        await this.deps.sleep(wait);
        continue;
      }
      if (res.ok) return (await res.json()) as unknown;

      const text = await res.text();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || lastAttempt) {
        throw new GeminiError(`Gemini API ${res.status}: ${text.slice(0, 500)}`, res.status);
      }
      const wait = retryDelayMs(text, attempt);
      this.deps.log(`Gemini ${res.status} (${errorMessage(text)}); retrying in ${Math.round(wait / 1000)}s`);
      await this.deps.sleep(wait);
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

/** The human-readable part of a Gemini error body (it names the exceeded quota on 429s). */
function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return parsed.error.message.slice(0, 300);
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return body.slice(0, 300);
}

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function stripCodeFence(text: string): string {
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim());
  return m?.[1] ?? text;
}
