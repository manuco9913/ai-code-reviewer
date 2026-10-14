import { describe, expect, it } from "vitest";
import { issueRefs } from "./issueRefs";

describe("issueRefs", () => {
  it("finds same-repo issue references in PR text, ignoring other repos and anchors", () => {
    const body = "Fixes #12 and closes me/app#7.\nRelated: other/lib#99, see #3 (and #12 again). Color #fff, [link](#setup)";

    expect(issueRefs(body, "me/app")).toEqual([12, 7, 3]);
  });
});
