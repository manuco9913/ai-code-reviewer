// Every external write DevFlow makes is proposed here first and runs only after a human approves.
// Approval is a compare-and-set on the action's status, so an action executes at most once.

export type ActionStatus = "pending" | "approved" | "rejected" | "executed" | "failed";

export interface InlineReviewComment {
  path: string;
  line: number;
  body: string;
}

export type ActionPayload =
  | { kind: "pr_review"; prNumber: number; commitId: string; body: string; comments: InlineReviewComment[] }
  | { kind: "pr_comment"; prNumber: number; body: string }
  | { kind: "issue_update"; issueNumber: number; comment: string | null; addLabels: string[] };

export interface PendingAction {
  id: string;
  repo: string;
  title: string;
  payload: ActionPayload;
  status: ActionStatus;
  /** What execution produced (e.g. the review URL) or { error }. */
  result: unknown;
  createdAt: string;
  decidedAt: string | null;
}

/** Port: persisted actions (Supabase pending_actions). */
export interface ActionStore {
  create(repo: string, title: string, payload: ActionPayload): Promise<PendingAction>;
  get(id: string): Promise<PendingAction | null>;
  list(status: ActionStatus): Promise<PendingAction[]>;
  /** Moves a pending action to `to`; null when it was not pending (already decided). */
  claim(id: string, to: "approved" | "rejected"): Promise<PendingAction | null>;
  finish(id: string, status: "executed" | "failed", result: unknown): Promise<PendingAction>;
}

/** Port: the GitHub writes DevFlow can make. */
export interface GitHubWriter {
  createReview(
    repo: string,
    prNumber: number,
    review: { commitId: string; body: string; comments: InlineReviewComment[] },
  ): Promise<{ url: string }>;
  createIssueComment(repo: string, number: number, body: string): Promise<{ url: string }>;
  addLabels(repo: string, number: number, labels: string[]): Promise<void>;
}

export class ActionNotFoundError extends Error {}

export class ActionConflictError extends Error {
  constructor(readonly status: ActionStatus) {
    super(`This action was already ${status}.`);
  }
}

export async function decideAction(
  id: string,
  decision: "approve" | "reject",
  deps: { store: ActionStore; github: GitHubWriter },
): Promise<PendingAction> {
  const claimed = await deps.store.claim(id, decision === "approve" ? "approved" : "rejected");
  if (!claimed) {
    const current = await deps.store.get(id);
    if (!current) throw new ActionNotFoundError(`No action ${id}`);
    throw new ActionConflictError(current.status);
  }
  if (decision === "reject") return claimed;

  try {
    return await deps.store.finish(id, "executed", await execute(claimed, deps.github));
  } catch (err) {
    return deps.store.finish(id, "failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

async function execute(action: PendingAction, github: GitHubWriter): Promise<unknown> {
  const p = action.payload;
  switch (p.kind) {
    case "pr_review":
      return github.createReview(action.repo, p.prNumber, { commitId: p.commitId, body: p.body, comments: p.comments });
    case "pr_comment":
      return github.createIssueComment(action.repo, p.prNumber, p.body);
    case "issue_update": {
      const comment = p.comment ? await github.createIssueComment(action.repo, p.issueNumber, p.comment) : null;
      if (p.addLabels.length) await github.addLabels(action.repo, p.issueNumber, p.addLabels);
      return { comment, labels: p.addLabels };
    }
  }
}
