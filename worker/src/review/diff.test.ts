import { describe, expect, it } from "vitest";
import { annotatePatch } from "./diff";

describe("annotatePatch", () => {
  it("numbers added and context lines with their new-file line numbers and marks them commentable", () => {
    const patch = ["@@ -10,3 +10,4 @@ function f() {", " const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = 4;", " return a;"].join(
      "\n",
    );

    const annotated = annotatePatch(patch);

    expect(annotated.text.split("\n")).toEqual([
      "@@ -10,3 +10,4 @@ function f() {",
      "   10   const a = 1;",
      "      - const b = 2;",
      "   11 + const b = 3;",
      "   12 + const c = 4;",
      "   13   return a;",
    ]);
    expect([...annotated.commentableLines].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
    expect(annotated.addedLines).toEqual([11, 12]);
  });
});
