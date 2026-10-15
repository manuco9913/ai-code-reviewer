// Network helpers shared by the Worker and the indexer.

/**
 * Wraps `fetch` so every request has a deadline; on expiry it rejects with a DOMException named
 * "TimeoutError". A caller-supplied signal still works alongside the deadline.
 */
export function fetchWithTimeout(fetchFn: typeof fetch, timeoutMs: number): typeof fetch {
  return (input, init) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    return fetchFn(input, { ...init, signal });
  };
}

export function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}
