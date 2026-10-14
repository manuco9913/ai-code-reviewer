import { describe, expect, it } from "vitest";
import { loadStandards } from "./standards";

/** A repo snapshot at the PR's base commit: path → content. */
function repoAt(files: Record<string, string>) {
  return {
    paths: Object.keys(files),
    read: async (path: string) => files[path] ?? null,
  };
}

describe("loadStandards — auto-discovery", () => {
  it("collects standards docs and review-relevant skills with their reference files, skipping process skills", async () => {
    const repo = repoAt({
      "CODING_STANDARDS.md": "# Coding standards\nNo any.",
      "CLAUDE.md": "Follow CODING_STANDARDS.md",
      "README.md": "# App",
      ".claude/skills/tdd/SKILL.md": "# TDD\nVertical slices.",
      ".claude/skills/tdd/mocking.md": "Mock at boundaries.",
      ".claude/skills/grill-me/SKILL.md": "Interview the user.",
      ".agents/skills/tdd/SKILL.md": "# TDD (duplicate copy)",
      "src/app.ts": "export {}",
    });

    const standards = await loadStandards(repo.paths, repo.read, ["src/app.ts"]);

    expect(standards.source).toBe("auto");
    expect(standards.docs.map((d) => d.path)).toEqual([
      "CODING_STANDARDS.md",
      "CLAUDE.md",
      ".claude/skills/tdd/SKILL.md",
      ".claude/skills/tdd/mocking.md",
    ]);
    expect(standards.docs[0]?.content).toContain("No any.");
  });
});

describe("loadStandards — .devflow.yml", () => {
  const files = {
    ".devflow.yml": [
      "standards:",
      "  - CODING_STANDARDS.md",
      "  - path: docs/agents/frontend-style.md",
      "    applies_to: ['frontend/**']",
      "skills:",
      "  - tdd",
      "ignore:",
      "  - 'research/**'",
    ].join("\n"),
    "CODING_STANDARDS.md": "rules",
    "CLAUDE.md": "not listed, so not used",
    "docs/agents/frontend-style.md": "CSS modules only",
    ".claude/skills/tdd/SKILL.md": "tdd",
  };

  it("uses only the configured documents and returns the ignore globs", async () => {
    const repo = repoAt(files);

    const standards = await loadStandards(repo.paths, repo.read, ["frontend/src/App.tsx"]);

    expect(standards.source).toBe("config");
    expect(standards.docs.map((d) => d.path)).toEqual([
      "CODING_STANDARDS.md",
      "docs/agents/frontend-style.md",
      ".claude/skills/tdd/SKILL.md",
    ]);
    expect(standards.ignore).toEqual(["research/**"]);
  });

  it("leaves out a scoped document when the PR touches none of its paths", async () => {
    const repo = repoAt(files);

    const standards = await loadStandards(repo.paths, repo.read, ["backend/app/main.py"]);

    expect(standards.docs.map((d) => d.path)).not.toContain("docs/agents/frontend-style.md");
  });
});

describe("loadStandards — problems", () => {
  it("falls back to auto-discovery with a warning when .devflow.yml is invalid", async () => {
    const repo = repoAt({ ".devflow.yml": "standards: [unclosed", "CODING_STANDARDS.md": "rules" });

    const standards = await loadStandards(repo.paths, repo.read, []);

    expect(standards.source).toBe("auto");
    expect(standards.docs.map((d) => d.path)).toEqual(["CODING_STANDARDS.md"]);
    expect(standards.warnings[0]).toMatch(/not valid YAML/);
  });

  it("warns about configured files that do not exist", async () => {
    const repo = repoAt({ ".devflow.yml": "standards: [STYLE.md]\nskills: [tdd]" });

    const standards = await loadStandards(repo.paths, repo.read, []);

    expect(standards.warnings).toEqual([
      '.devflow.yml: standard "STYLE.md" not found',
      '.devflow.yml: skill "tdd" not found',
    ]);
  });

  it("caps the total standards text, keeping higher-priority documents whole and saying what was cut", async () => {
    const repo = repoAt({
      "CODING_STANDARDS.md": "a".repeat(30_000),
      ".claude/skills/tdd/SKILL.md": "b".repeat(20_000),
      ".claude/skills/tdd/tests.md": "c".repeat(20_000),
    });

    const standards = await loadStandards(repo.paths, repo.read, []);

    expect(standards.docs.reduce((n, d) => n + d.content.length, 0)).toBeLessThanOrEqual(60_000);
    expect(standards.docs[0]?.content).toHaveLength(30_000);
    expect(standards.warnings).toContainEqual(expect.stringContaining(".claude/skills/tdd/tests.md"));
  });
});
