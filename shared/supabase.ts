// Tiny PostgREST adapter for Supabase. Avoids pulling supabase-js into the Worker bundle.
// Row types are cast once here: they are defined by supabase/schema.sql, which we own.

export type Query = Record<string, string>;

export class SupabaseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SupabaseError";
  }
}

interface RequestOptions {
  query: Query | null;
  body: unknown;
  prefer: string | null;
}

export class Supabase {
  private readonly base: string;

  constructor(
    url: string,
    private readonly key: string,
    private readonly fetchFn: typeof fetch,
  ) {
    this.base = `${url.replace(/\/+$/, "")}/rest/v1`;
  }

  select<T>(table: string, query: Query): Promise<T[]> {
    return this.request<T[]>("GET", table, { query, body: undefined, prefer: null });
  }

  /** Pages through every matching row. `query` must include a stable `order`. */
  async selectAll<T>(table: string, query: Query & { order: string }): Promise<T[]> {
    const pageSize = 1000; // PostgREST's default max-rows on Supabase
    const rows: T[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.select<T>(table, { ...query, limit: String(pageSize), offset: String(offset) });
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }

  /** Inserts rows and returns them as stored (with defaults such as ids). */
  async insert<T>(table: string, rows: unknown[]): Promise<T[]> {
    return this.request<T[]>("POST", table, { query: null, body: rows, prefer: "return=representation" });
  }

  /** Inserts or merges rows on the `onConflict` columns; returns nothing. */
  async upsert(table: string, rows: unknown[], onConflict: string): Promise<void> {
    await this.request<null>("POST", table, {
      query: { on_conflict: onConflict },
      body: rows,
      prefer: "return=minimal,resolution=merge-duplicates",
    });
  }

  /** PATCHes rows matching `filter`; returns the updated rows. */
  update<T>(table: string, filter: Query, patch: unknown): Promise<T[]> {
    return this.request<T[]>("PATCH", table, { query: filter, body: patch, prefer: "return=representation" });
  }

  async delete(table: string, filter: Query): Promise<void> {
    await this.request<null>("DELETE", table, { query: filter, body: undefined, prefer: "return=minimal" });
  }

  rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    return this.request<T>("POST", `rpc/${fn}`, { query: null, body: args, prefer: null });
  }

  private async request<T>(method: string, path: string, opts: RequestOptions): Promise<T> {
    const headers: Record<string, string> = { apikey: this.key, "content-type": "application/json" };
    // Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys must not.
    if (this.key.startsWith("eyJ")) headers.authorization = `Bearer ${this.key}`;
    if (opts.prefer) headers.prefer = opts.prefer;

    const qs = opts.query ? `?${new URLSearchParams(opts.query)}` : "";
    const res = await this.fetchFn(`${this.base}/${path}${qs}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new SupabaseError(`Supabase ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`, res.status);
    }
    return (text ? JSON.parse(text) : null) as T;
  }
}

/** Quotes a value for use inside PostgREST list syntax: in.(...) / cs.{...}. */
export function pgQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function inFilter(values: string[]): string {
  return `in.(${values.map(pgQuote).join(",")})`;
}
