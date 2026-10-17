import { describe, expect, it } from "vitest";
import { FakeGitHubWriter, MemoryActionStore } from "../testing/fakes";
import { ActionConflictError, decideAction, type ActionPayload } from "./actions";

const reviewPayload: ActionPayload = {
  kind: "pr_review",
  prNumber: 5,
  commitId: "head1",
  body: "Looks good overall.",
  comments: [{ path: "src/a.ts", line: 3, body: "Off by one" }],
};

async function setup() {
  const store = new MemoryActionStore();
  const github = new FakeGitHubWriter();
  const action = await store.create("me/app", "Post review on #5", reviewPayload);
  return { store, github, action };
}

describe("decideAction", () => {
  it("posts the proposed review when approved and records the result", async () => {
    const { store, github, action } = await setup();

    const decided = await decideAction(action.id, "approve", { store, github });

    expect(github.reviews).toEqual([{ repo: "me/app", prNumber: 5, body: "Looks good overall." }]);
    expect(decided.status).toBe("executed");
    expect(decided.result).toEqual({ url: "https://github.com/me/app/pull/5#review" });
  });

  it("never posts twice: a second decision on the same action is refused", async () => {
    const { store, github, action } = await setup();
    await decideAction(action.id, "approve", { store, github });

    await expect(decideAction(action.id, "approve", { store, github })).rejects.toBeInstanceOf(ActionConflictError);
    expect(github.reviews).toHaveLength(1);
  });

  it("posts nothing when rejected", async () => {
    const { store, github, action } = await setup();

    const decided = await decideAction(action.id, "reject", { store, github });

    expect(decided.status).toBe("rejected");
    expect(github.reviews).toEqual([]);
  });

  it("records a GitHub failure on the action instead of losing it", async () => {
    const { store, github, action } = await setup();
    github.failWith = new Error("422 line must be part of the diff");

    const decided = await decideAction(action.id, "approve", { store, github });

    expect(decided.status).toBe("failed");
    expect(decided.result).toEqual({ error: "422 line must be part of the diff" });
  });

  it("comments on and labels an issue for an approved issue update", async () => {
    const store = new MemoryActionStore();
    const github = new FakeGitHubWriter();
    const action = await store.create("me/app", "Update #12", {
      kind: "issue_update",
      issueNumber: 12,
      comment: "PR #5 leaves member discounts unimplemented.",
      addLabels: ["needs-work"],
    });

    await decideAction(action.id, "approve", { store, github });

    expect(github.comments).toEqual([{ repo: "me/app", number: 12, body: "PR #5 leaves member discounts unimplemented." }]);
    expect(github.labels).toEqual([{ repo: "me/app", number: 12, labels: ["needs-work"] }]);
  });
});
