// The automated review pipeline a PR webhook triggers: review the commit once, propose the
// GitHub updates for approval, and email the summary with signed approval links.

import type { ActionStore, PendingAction } from "../actions/actions";
import { reviewPullRequest, type ReviewDeps, type ReviewResult } from "../review/reviewer";
import { signActionToken } from "../security";
import { reviewEmail, type Email } from "./email";
import type { ReviewJob } from "./events";

/** Port: stored reviews (Supabase reviews table), one per PR commit. */
export interface ReviewStore {
  hasReviewed(repo: string, prNumber: number, headSha: string): Promise<boolean>;
  save(result: ReviewResult): Promise<void>;
}

/** Port: outgoing email (Resend). */
export interface Mailer {
  send(email: Email): Promise<void>;
}

export interface ApprovalLinks {
  /** Public origin of the Worker, e.g. https://devflow.you.workers.dev */
  baseUrl: string;
  secret: string;
  ttlMs: number;
  now: () => number;
}

export interface ReviewJobDeps {
  review: ReviewDeps;
  reviews: ReviewStore;
  actions: ActionStore;
  mailer: Mailer;
  links: ApprovalLinks;
}

export type JobOutcome =
  | { status: "skipped"; reason: string }
  | { status: "reviewed"; result: ReviewResult; actions: PendingAction[] };

export async function runReviewJob(job: ReviewJob, deps: ReviewJobDeps): Promise<JobOutcome> {
  if (await deps.reviews.hasReviewed(job.repo, job.prNumber, job.headSha)) {
    return { status: "skipped", reason: `commit ${job.headSha.slice(0, 7)} was already reviewed` };
  }

  const result = await reviewPullRequest({ repo: job.repo, prNumber: job.prNumber }, deps.review);
  await deps.reviews.save(result);

  const actions = [
    await deps.actions.create(result.repo, `Post the review on PR #${result.prNumber}`, {
      kind: "pr_review",
      prNumber: result.prNumber,
      commitId: result.headSha,
      body: result.reviewBody,
      comments: result.inlineComments,
    }),
  ];
  const unmet = result.requirements.status === "partially_met" || result.requirements.status === "not_met";
  const issueNumber = result.linkedIssues[0];
  if (unmet && issueNumber !== undefined) {
    actions.push(
      await deps.actions.create(result.repo, `Comment on issue #${issueNumber}`, {
        kind: "issue_update",
        issueNumber,
        comment: requirementsComment(result),
        addLabels: [],
      }),
    );
  }

  const links = await Promise.all(actions.map(async (action) => ({ action, url: await approvalUrl(action.id, deps.links) })));
  await deps.mailer.send(reviewEmail(result, links));
  return { status: "reviewed", result, actions };
}

export async function approvalUrl(actionId: string, links: ApprovalLinks): Promise<string> {
  const token = await signActionToken(links.secret, actionId, links.now() + links.ttlMs);
  return `${links.baseUrl.replace(/\/+$/, "")}/actions/${encodeURIComponent(actionId)}?token=${token}`;
}

function requirementsComment(result: ReviewResult): string {
  const missing = result.requirements.missing.map((m) => `- ${m}`).join("\n");
  return [
    `DevFlow AI reviewed ${result.prUrl} against this issue: **${result.requirements.status.replace("_", " ")}**.`,
    result.requirements.notes,
    missing ? `Not yet covered:\n${missing}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
