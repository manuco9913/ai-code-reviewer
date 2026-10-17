import { describe, expect, it } from "vitest";
import { reviewJobFor } from "./events";

const prEvent = (action: string, pr: Record<string, unknown> = {}) => ({
  action,
  repository: { full_name: "me/app" },
  pull_request: { number: 7, draft: false, state: "open", head: { sha: "abc123" }, ...pr },
});

describe("reviewJobFor", () => {
  it("reviews a PR when it is opened, gets new commits, is reopened or leaves draft", () => {
    for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
      expect(reviewJobFor("pull_request", prEvent(action))).toEqual({ repo: "me/app", prNumber: 7, headSha: "abc123" });
    }
  });

  it("ignores drafts, closed PRs, other PR actions and other events", () => {
    expect(reviewJobFor("pull_request", prEvent("opened", { draft: true }))).toBeNull();
    expect(reviewJobFor("pull_request", prEvent("synchronize", { state: "closed" }))).toBeNull();
    expect(reviewJobFor("pull_request", prEvent("labeled"))).toBeNull();
    expect(reviewJobFor("push", prEvent("opened"))).toBeNull();
    expect(reviewJobFor("pull_request", { action: "opened" })).toBeNull();
  });
});
