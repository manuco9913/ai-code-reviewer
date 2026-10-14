import { describe, expect, it } from "vitest";
import { Gemini, GeminiError } from "./gemini";

const config = { apiKey: "k", model: "flash", embeddingModel: "embed", maxRetries: 2 };

function fakeFetch(responses: Response[]) {
  const requests: { url: string; body: unknown }[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  };
  return { fetch: fetchFn as typeof fetch, requests };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function client(responses: Response[]) {
  const waits: number[] = [];
  const net = fakeFetch(responses);
  const gemini = new Gemini(config, { fetch: net.fetch, sleep: async (ms) => void waits.push(ms) });
  return { gemini, waits, requests: net.requests };
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
