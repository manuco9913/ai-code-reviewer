import { describe, expect, it } from "vitest";
import { verifyActionToken } from "../security";
import {
  FakeGitHub,
  FakeMailer,
  FakeModel,
  FakeSearch,
  finding,
  MemoryActionStore,
  MemoryReviewStore,
  modelAnswer,
} from "../testing/fakes";
import { runReviewJob } from "./reviewJob";

const SECRET = "approval-secret";
const NOW = Date.UTC(2026, 9, 17);
const job = { repo: "me/app", prNumber: 5, headSha: "head1" };

function setup(answer: unknown = modelAnswer([finding({ line: 2 })])) {
  const github = new FakeGitHub();
  const deps = {
    review: { github, search: new FakeSearch(), model: new FakeModel(answer) },
    reviews: new MemoryReviewStore(),
    actions: new MemoryActionStore(),
    mailer: new FakeMailer(),
    links: { baseUrl: "https://devflow.example", secret: SECRET, ttlMs: 7 * 24 * 3600_000, now: () => NOW },
  };
  return { github, deps };
}

describe("runReviewJob", () => {
  it("reviews the commit, proposes the GitHub review for approval and emails a signed approval link", async () => {
    const { deps } = setup();

    const outcome = await runReviewJob(job, deps);

    expect(outcome.status).toBe("reviewed");
    const [proposal] = await deps.actions.list("pending");
    expect(proposal?.payload).toMatchObject({
      kind: "pr_review",
      prNumber: 5,
      commitId: "head1",
      comments: [{ path: "src/price.ts", line: 2 }],
    });

    const email = deps.mailer.sent[0];
    expect(email?.subject).toContain("me/app #5");
    const link = /https:\/\/devflow\.example\/actions\/([\w-]+)\?token=([\w.]+)/.exec(email?.html ?? "");
    expect(link?.[1]).toBe(proposal?.id);
    expect(await verifyActionToken(SECRET, link?.[1] ?? "", link?.[2] ?? null, NOW)).toBe(true);
  });

  it("does nothing for a commit that was already reviewed", async () => {
    const { deps } = setup();
    await runReviewJob(job, deps);

    const again = await runReviewJob(job, deps);

    expect(again.status).toBe("skipped");
    expect(deps.mailer.sent).toHaveLength(1);
    expect(await deps.actions.list("pending")).toHaveLength(1);
  });

  it("also proposes an issue comment when linked requirements are not fully met", async () => {
    const answer = {
      ...modelAnswer([]),
      requirements: { status: "partially_met", notes: "Savings are not shown.", missing: ["Display the amount saved"] },
    };
    const { github, deps } = setup(answer);
    github.closing = [14];
    github.issues.set(14, { number: 14, title: "Show savings", body: "Display the amount saved.", state: "open", labels: [], url: "u" });

    await runReviewJob(job, deps);

    const proposals = await deps.actions.list("pending");
    expect(proposals.map((p) => p.payload.kind).sort()).toEqual(["issue_update", "pr_review"]);
    const issueUpdate = proposals.find((p) => p.payload.kind === "issue_update")?.payload;
    expect(issueUpdate).toMatchObject({ issueNumber: 14, comment: expect.stringContaining("Display the amount saved") });
  });

  it("escapes text from the PR and the model in the email", async () => {
    const { deps } = setup(modelAnswer([finding({ title: "<img src=x onerror=alert(1)>" })]));

    await runReviewJob(job, deps);

    expect(deps.mailer.sent[0]?.html).not.toContain("<img src=x");
    expect(deps.mailer.sent[0]?.html).toContain("&lt;img src=x");
  });
});
