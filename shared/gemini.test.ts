import { describe, expect, it } from "vitest";
import { Gemini, GeminiError } from "./gemini";

const config = { apiKey: "k", model: "flash", embeddingModel: "embed", maxRetries: 2, embedTextsPerMinute: 100_000 };

function fakeFetch(responses: (Response | Error)[]) {
  const requests: { url: string; body: unknown }[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch: fetchFn as typeof fetch, requests };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function client(responses: (Response | Error)[]) {
  const waits: number[] = [];
  const logs: string[] = [];
  const net = fakeFetch(responses);
  const gemini = new Gemini(config, {
    fetch: net.fetch,
    sleep: async (ms) => void waits.push(ms),
    log: (message) => void logs.push(message),
    now: () => 0,
  });
  return { gemini, waits, logs, requests: net.requests };
}

describe("Gemini", () => {
  it("waits for the server's retry hint after a rate limit, then succeeds", async () => {
    const rateLimited = json({ error: { details: [{ retryDelay: "7s" }] } }, 429);
    const ok = json({ candidates: [{ content: { parts: [{ text: "hi" }] } }] });
    const { gemini, waits } = client([rateLimited, ok]);

    const reply = await gemini.generate({ system: "s", contents: [], temperature: 0 });

    expect(reply.parts[0]?.text).toBe("hi");
    expect(waits).toEqual([7000]);
  });

  it("retries a request that timed out, and logs why it waited", async () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    const ok = json({ candidates: [{ content: { parts: [{ text: "hi" }] } }] });
    const { gemini, logs } = client([timeout, ok]);

    const reply = await gemini.generate({ system: "s", contents: [], temperature: 0 });

    expect(reply.parts[0]?.text).toBe("hi");
    expect(logs[0]).toMatch(/timed out/i);
  });

  it("logs the quota Gemini reports when rate limited", async () => {
    const body = { error: { message: "Quota exceeded for metric: embed_content_free_tier_requests, limit: 100" } };
    const { gemini, logs } = client([json(body, 429), json({ embeddings: [{ values: [1] }] })]);

    await gemini.embedDocuments(["x"]);

    expect(logs[0]).toContain("embed_content_free_tier_requests, limit: 100");
  });

  it("gives up after maxRetries and reports the status", async () => {
    const { gemini } = client([json({}, 503), json({}, 503), json({}, 503)]);

    await expect(gemini.generate({ system: "s", contents: [], temperature: 0 })).rejects.toMatchObject({
      status: 503,
    });
  });

  it("does not retry client errors", async () => {
    const { gemini, waits } = client([json({ error: "bad key" }, 400)]);

    await expect(gemini.generate({ system: "s", contents: [], temperature: 0 })).rejects.toBeInstanceOf(GeminiError);
    expect(waits).toEqual([]);
  });

  it("parses JSON answers even when wrapped in a code fence", async () => {
    const { gemini } = client([json({ candidates: [{ content: { parts: [{ text: '```json\n{"a":1}\n```' }] } }] })]);

    const value = await gemini.generateJson({ system: "s", contents: [], temperature: 0 }, { type: "OBJECT" }, (v) => v);

    expect(value).toEqual({ a: 1 });
  });

  it("returns unit-length document embeddings, batching 100 texts per request", async () => {
    const batch = (n: number) => json({ embeddings: Array.from({ length: n }, () => ({ values: [3, 4] })) });
    const { gemini, requests } = client([batch(100), batch(20)]);

    const vectors = await gemini.embedDocuments(Array.from({ length: 120 }, (_, i) => `text ${i}`));

    expect(vectors).toHaveLength(120);
    expect(vectors[0]).toEqual([0.6, 0.8]);
    expect(requests).toHaveLength(2);
  });
});

describe("Gemini embedding pacing", () => {
  it("spaces embedding batches to stay within the texts-per-minute budget", async () => {
    let clock = 0;
    const waits: number[] = [];
    const batch = (n: number) => json({ embeddings: Array.from({ length: n }, () => ({ values: [1] })) });
    const net = fakeFetch([batch(100), batch(100), batch(50)]);
    const gemini = new Gemini(
      { ...config, embedTextsPerMinute: 100 },
      {
        fetch: net.fetch,
        sleep: async (ms) => {
          waits.push(ms);
          clock += ms;
        },
        log: () => {},
        now: () => clock,
      },
    );

    await gemini.embedDocuments(Array.from({ length: 250 }, (_, i) => `t${i}`));

    expect(net.requests).toHaveLength(3);
    expect(waits).toEqual([60_000, 60_000]);
  });
});
