// In-memory fakes for DevFlow's system boundaries (GitHub, code search, Gemini, the action store).
// Shared by tests; never imported by production code.

import type { CodeHit } from "../../../shared/codeSearch";
import type { ActionPayload, ActionStatus, ActionStore, GitHubWriter, PendingAction } from "../actions/actions";
import type { CheckRun, Commit, GitHubReader, Issue, PullRequest, PullRequestFile } from "../github/types";
import type { ReviewModel } from "../review/reviewer";

export const REPO = "me/app";

/** In-memory GitHub (a system boundary). Files are keyed by ref so base and head can differ. */
export class FakeGitHub implements GitHubReader {
  pr: PullRequest = {
    number: 5,
    title: "Add discount calculation",
    body: "Implements pricing rules.",
    author: "dev",
    url: "https://github.com/me/app/pull/5",
    state: "open",
    headSha: "head1",
    baseSha: "base1",
    headRef: "feature/discount",
    baseRef: "main",
  };
  files: PullRequestFile[] = [
    {
      path: "src/price.ts",
      status: "modified",
      additions: 2,
      deletions: 0,
      patch: ["@@ -1,2 +1,4 @@", " export function price(p: number) {", "+  const d = p * 0.1;", "+  return p - d;", " }"].join("\n"),
    },
  ];
  commits: Commit[] = [{ sha: "c1", message: "Add discount" }];
  closing: number[] = [];
  issues = new Map<number, Issue>();
  trees = new Map<string, Record<string, string>>([["base1", {}], ["head1", {}]]);
  checks: CheckRun[] = [];

  async getPullRequest() {
    return this.pr;
  }
  async listPullRequestFiles() {
    return this.files;
  }
  async listPullRequestCommits() {
    return this.commits;
  }
  async getClosingIssueNumbers() {
    return this.closing;
  }
  async getIssue(_repo: string, n: number) {
    return this.issues.get(n) ?? null;
  }
  async listFiles(_repo: string, ref: string) {
    return Object.keys(this.trees.get(ref) ?? {});
  }
  async getFile(_repo: string, path: string, ref: string) {
    return this.trees.get(ref)?.[path] ?? null;
  }
  async listCheckRuns() {
    return this.checks;
  }
}

/** In-memory index: code hits always, Markdown hits only when docs are requested (like hybrid_search). */
export class FakeSearch {
  hits: CodeHit[] = [];
  docHits: CodeHit[] = [];
  async searchMany(_repo: string, queries: string[], opts: { includeDocs: boolean }) {
    return queries.map(() => (opts.includeDocs ? [...this.docHits, ...this.hits] : this.hits));
  }
}

export const docHit = (id: number, path: string, content: string): CodeHit => ({
  id,
  path,
  symbol: null,
  kind: "section",
  language: "markdown",
  start_line: 1,
  end_line: 5,
  content,
  score: 0.03,
});

/** Stands in for Gemini: returns a canned review and keeps the prompt it was sent. */
export class FakeModel implements ReviewModel {
  prompt = "";
  system = "";
  constructor(private readonly answer: unknown) {}
  async generateJson<T>(
    opts: { system: string; contents: { parts: { text?: string }[] }[] },
    _schema: unknown,
    parse: (value: unknown) => T,
  ) {
    this.system = opts.system;
    this.prompt = opts.contents.flatMap((c) => c.parts.map((p) => p.text ?? "")).join("\n");
    return parse(this.answer);
  }
}

export function finding(overrides: Record<string, unknown>) {
  return {
    severity: "medium",
    category: "bug",
    file: "src/price.ts",
    line: 2,
    title: "Hard-coded discount",
    description: "The 10% rate is hard-coded.",
    suggestion: "Pass the rate in.",
    rule: "",
    ...overrides,
  };
}

export function modelAnswer(findings: Record<string, unknown>[]) {
  return {
    summary: "Adds a flat discount.",
    verdict: "comment",
    requirements: { status: "no_linked_issue", notes: "", missing: [] },
    findings,
  };
}

/** In-memory stand-in for the pending_actions table, with the same compare-and-set claim. */
export class MemoryActionStore implements ActionStore {
  rows = new Map<string, PendingAction>();
  private next = 1;

  async create(repo: string, title: string, payload: ActionPayload): Promise<PendingAction> {
    const action: PendingAction = {
      id: `a${this.next++}`,
      repo,
      title,
      payload,
      status: "pending",
      result: null,
      createdAt: "2026-10-17T00:00:00Z",
      decidedAt: null,
    };
    this.rows.set(action.id, action);
    return action;
  }
  async get(id: string) {
    return this.rows.get(id) ?? null;
  }
  async list(status: ActionStatus) {
    return [...this.rows.values()].filter((a) => a.status === status);
  }
  async claim(id: string, to: "approved" | "rejected") {
    const row = this.rows.get(id);
    if (!row || row.status !== "pending") return null;
    const claimed = { ...row, status: to, decidedAt: "2026-10-17T01:00:00Z" };
    this.rows.set(id, claimed);
    return claimed;
  }
  async finish(id: string, status: "executed" | "failed", result: unknown) {
    const row = this.rows.get(id);
    if (!row) throw new Error("missing");
    const done = { ...row, status, result };
    this.rows.set(id, done);
    return done;
  }
}

/** Records what would have been written to GitHub. */
export class FakeGitHubWriter implements GitHubWriter {
  reviews: { repo: string; prNumber: number; body: string }[] = [];
  comments: { repo: string; number: number; body: string }[] = [];
  labels: { repo: string; number: number; labels: string[] }[] = [];
  failWith: Error | null = null;

  async createReview(repo: string, prNumber: number, review: { body: string }) {
    if (this.failWith) throw this.failWith;
    this.reviews.push({ repo, prNumber, body: review.body });
    return { url: `https://github.com/${repo}/pull/${prNumber}#review` };
  }
  async createIssueComment(repo: string, number: number, body: string) {
    this.comments.push({ repo, number, body });
    return { url: `https://github.com/${repo}/issues/${number}#comment` };
  }
  async addLabels(repo: string, number: number, labels: string[]) {
    this.labels.push({ repo, number, labels });
  }
}

/** Remembers which commits were reviewed (stand-in for the reviews table). */
export class MemoryReviewStore {
  saved: { repo: string; prNumber: number; headSha: string }[] = [];
  async hasReviewed(repo: string, prNumber: number, headSha: string) {
    return this.saved.some((r) => r.repo === repo && r.prNumber === prNumber && r.headSha === headSha);
  }
  async save(result: { repo: string; prNumber: number; headSha: string }) {
    this.saved.push({ repo: result.repo, prNumber: result.prNumber, headSha: result.headSha });
  }
}

/** Collects emails instead of sending them (stand-in for Resend). */
export class FakeMailer {
  sent: { subject: string; html: string; text: string }[] = [];
  async send(email: { subject: string; html: string; text: string }) {
    this.sent.push(email);
  }
}
