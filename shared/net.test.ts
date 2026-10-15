import { describe, expect, it } from "vitest";
import { fetchWithTimeout } from "./net";

/** A server that never answers, but stops waiting when the request is aborted. */
const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  })) as typeof fetch;

describe("fetchWithTimeout", () => {
  it("fails a request that takes longer than the deadline instead of hanging forever", async () => {
    const fetchFn = fetchWithTimeout(hangingFetch, 20);

    await expect(fetchFn("https://example.test")).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("passes fast responses through", async () => {
    const fetchFn = fetchWithTimeout((async () => new Response("ok")) as typeof fetch, 1000);

    expect(await (await fetchFn("https://example.test")).text()).toBe("ok");
  });
});
