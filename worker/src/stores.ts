// Supabase adapters for the action and review stores. The only Worker code that knows these tables.

import { pgQuote, type Supabase } from "../../shared/supabase";
import type { ActionPayload, ActionStatus, ActionStore, PendingAction } from "./actions/actions";
import type { DependencyIndex } from "./agent/agent";
import type { ReviewStore } from "./automation/reviewJob";
import type { ReviewResult } from "./review/reviewer";

interface ActionRow {
  id: string;
  repo: string;
  kind: ActionPayload["kind"];
  title: string;
  payload: ActionPayload;
  status: ActionStatus;
  result: unknown;
  created_at: string;
  decided_at: string | null;
}

const toAction = (r: ActionRow): PendingAction => ({
  id: r.id,
  repo: r.repo,
  title: r.title,
  payload: r.payload,
  status: r.status,
  result: r.result,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SupabaseActionStore implements ActionStore {
  constructor(private readonly db: Supabase) {}

  async create(repo: string, title: string, payload: ActionPayload): Promise<PendingAction> {
    const [row] = await this.db.insert<ActionRow>("pending_actions", [{ repo, title, kind: payload.kind, payload }]);
    if (!row) throw new Error("Supabase returned no row for the new action");
    return toAction(row);
  }

  async get(id: string): Promise<PendingAction | null> {
    if (!UUID.test(id)) return null; // also keeps arbitrary input out of the PostgREST filter
    const [row] = await this.db.select<ActionRow>("pending_actions", { id: `eq.${id}`, select: "*" });
    return row ? toAction(row) : null;
  }

  async list(status: ActionStatus): Promise<PendingAction[]> {
    const rows = await this.db.select<ActionRow>("pending_actions", {
      status: `eq.${status}`,
      select: "*",
      order: "created_at.desc",
      limit: "100",
    });
    return rows.map(toAction);
  }

  /** Compare-and-set: only a row still 'pending' is updated, so two approvals can't both win. */
  async claim(id: string, to: "approved" | "rejected"): Promise<PendingAction | null> {
    if (!UUID.test(id)) return null;
    const [row] = await this.db.update<ActionRow>(
      "pending_actions",
      { id: `eq.${id}`, status: "eq.pending" },
      { status: to, decided_at: new Date().toISOString() },
    );
    return row ? toAction(row) : null;
  }

  async finish(id: string, status: "executed" | "failed", result: unknown): Promise<PendingAction> {
    const [row] = await this.db.update<ActionRow>("pending_actions", { id: `eq.${id}` }, { status, result });
    if (!row) throw new Error(`Action ${id} disappeared while executing`);
    return toAction(row);
  }
}

export class SupabaseReviewStore implements ReviewStore {
  constructor(private readonly db: Supabase) {}

  async hasReviewed(repo: string, prNumber: number, headSha: string): Promise<boolean> {
    const rows = await this.db.select<{ id: string }>("reviews", {
      repo: `eq.${repo}`,
      pr_number: `eq.${prNumber}`,
      head_sha: `eq.${headSha}`,
      select: "id",
      limit: "1",
    });
    return rows.length > 0;
  }

  async save(result: ReviewResult): Promise<void> {
    await this.db.upsert(
      "reviews",
      [{ repo: result.repo, pr_number: result.prNumber, head_sha: result.headSha, result }],
      "repo,pr_number,head_sha",
    );
  }
}

/** The indexer's import graph (code_files), for the agent's analyze_dependencies tool. */
export class SupabaseDependencyIndex implements DependencyIndex {
  constructor(private readonly db: Supabase) {}

  async fileDeps(repo: string, path: string): Promise<{ imports: string[]; packages: string[] } | null> {
    const [row] = await this.db.select<{ imports: string[]; packages: string[] }>("code_files", {
      repo: `eq.${repo}`,
      path: `eq.${path}`,
      select: "imports,packages",
    });
    return row ?? null;
  }

  async dependents(repo: string, path: string): Promise<string[]> {
    const rows = await this.db.select<{ path: string }>("code_files", {
      repo: `eq.${repo}`,
      imports: `cs.{${pgQuote(path)}}`,
      select: "path",
      order: "path",
      limit: "50",
    });
    return rows.map((r) => r.path);
  }
}
