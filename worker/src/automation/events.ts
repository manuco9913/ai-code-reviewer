// Which GitHub webhook events start a review.

export interface ReviewJob {
  repo: string;
  prNumber: number;
  /** The commit to review; a newer push makes this job stale. */
  headSha: string;
}

const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

/** The review to run for a webhook delivery, or null when the event needs none. */
export function reviewJobFor(event: string, payload: unknown): ReviewJob | null {
  if (event !== "pull_request" || !isRecord(payload)) return null;
  if (typeof payload.action !== "string" || !REVIEW_ACTIONS.has(payload.action)) return null;

  const pr = payload.pull_request;
  const repo = isRecord(payload.repository) ? payload.repository.full_name : undefined;
  if (!isRecord(pr) || typeof repo !== "string") return null;
  if (pr.draft === true || pr.state !== "open") return null;

  const headSha = isRecord(pr.head) ? pr.head.sha : undefined;
  if (typeof pr.number !== "number" || typeof headSha !== "string") return null;
  return { repo, prNumber: pr.number, headSha };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
