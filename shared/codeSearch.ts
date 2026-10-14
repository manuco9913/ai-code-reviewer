// Hybrid (semantic + keyword) code search over the index. Used by the reviewer, the agent and
// the `npm run search` CLI.

import type { Gemini } from "./gemini";
import type { Supabase } from "./supabase";

export interface CodeHit {
  id: number;
  path: string;
  symbol: string | null;
  kind: string;
  language: string;
  start_line: number;
  end_line: number;
  content: string;
  score: number;
}

export interface SearchOptions {
  limit: number;
  /** Only search under this path, e.g. "backend/". Null searches the whole repo. */
  pathPrefix: string | null;
}

export class CodeSearch {
  constructor(
    private readonly db: Supabase,
    private readonly gemini: Gemini,
  ) {}

  async search(repo: string, query: string, opts: SearchOptions): Promise<CodeHit[]> {
    return (await this.searchMany(repo, [query], opts))[0] ?? [];
  }

  /** Runs several queries with a single embedding call; results are per query, best first. */
  async searchMany(repo: string, queries: string[], opts: SearchOptions): Promise<CodeHit[][]> {
    if (!queries.length) return [];
    const embeddings = await this.gemini.embedQueries(queries);
    return Promise.all(
      queries.map((query, i) =>
        this.db.rpc<CodeHit[]>("hybrid_search", {
          p_repo: repo,
          p_query: query,
          p_embedding: embeddings[i],
          p_match_count: opts.limit,
          p_path_prefix: opts.pathPrefix,
        }),
      ),
    );
  }
}
