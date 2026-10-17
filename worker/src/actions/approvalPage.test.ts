import { describe, expect, it } from "vitest";
import { signActionToken } from "../security";
import { FakeGitHubWriter, MemoryActionStore } from "../testing/fakes";
import { approvalResponse } from "./approvalPage";

const SECRET = "approval-secret";
const NOW = Date.UTC(2026, 9, 17);

async function setup() {
  const store = new MemoryActionStore();
  const github = new FakeGitHubWriter();
  const action = await store.create("me/app", "Post the review on PR #5", {
    kind: "pr_review",
    prNumber: 5,
    commitId: "head1",
    body: "Summary <b>bold</b>",
    comments: [{ path: "src/a.ts", line: 3, body: "Off by one" }],
  });
  const token = await signActionToken(SECRET, action.id, NOW + 3600_000);
  const deps = { store, github, secret: SECRET, now: () => NOW };
  return { store, github, action, token, deps };
}

describe("approvalResponse", () => {
  it("shows the proposal with approve and reject buttons, and changes nothing just by being opened", async () => {
    const { action, token, deps, github, store } = await setup();

    const page = await approvalResponse({ method: "GET", actionId: action.id, token, decision: null }, deps);

    expect(page.status).toBe(200);
    expect(page.html).toContain("Summary &lt;b&gt;bold&lt;/b&gt;");
    expect(page.html).toContain("src/a.ts:3");
    expect(page.html).toMatch(/<button[^>]*value="approve"/);
    expect(page.html).toMatch(/<button[^>]*value="reject"/);
    expect(github.reviews).toEqual([]);
    expect((await store.get(action.id))?.status).toBe("pending");
  });

  it("posts the review when approved with a valid token", async () => {
    const { action, token, deps, github } = await setup();

    const page = await approvalResponse({ method: "POST", actionId: action.id, token, decision: "approve" }, deps);

    expect(page.status).toBe(200);
    expect(github.reviews).toHaveLength(1);
    expect(page.html).toContain("https://github.com/me/app/pull/5#review");
  });

  it("refuses an invalid or expired token without touching anything", async () => {
    const { action, deps, github } = await setup();
    const expired = await signActionToken(SECRET, action.id, NOW - 1);

    for (const token of ["forged.token", expired]) {
      const page = await approvalResponse({ method: "POST", actionId: action.id, token, decision: "approve" }, deps);
      expect(page.status).toBe(403);
    }
    expect(github.reviews).toEqual([]);
  });

  it("explains when the action was already decided", async () => {
    const { action, token, deps } = await setup();
    await approvalResponse({ method: "POST", actionId: action.id, token, decision: "reject" }, deps);

    const page = await approvalResponse({ method: "POST", actionId: action.id, token, decision: "approve" }, deps);

    expect(page.status).toBe(409);
    expect(page.html).toContain("already rejected");
  });
});
