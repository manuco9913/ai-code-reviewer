// The agent's tools. Each declares its arguments for Gemini and returns plain JSON. Arguments come
// from the model, so they are validated here like any other untrusted input.

import type { FunctionDeclaration } from "../../../shared/gemini";
import type { PendingAction } from "../actions/actions";
import { annotatePatch } from "../review/diff";
import { reviewPullRequest, type ReviewDeps } from "../review/reviewer";
import type { AgentDeps } from "./agent";

export interface Tool {
  declaration: FunctionDeclaration;
  run(args: Record<string, unknown>, repo: string): Promise<unknown>;
}

export class ToolInputError extends Error {}

/** Lines returned by read_file when no range is given. */
const MAX_FILE_LINES = 300;
/** Total diff text get_pull_request returns. */
const MAX_DIFF_CHARS = 40_000;
const MANIFESTS = new Set(["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "Pipfile"]);

/** `onProposal` receives every pending action the agent creates. */
export function agentTools(deps: AgentDeps, onProposal: (action: PendingAction) => void): Tool[] {
  const propose = async (...args: Parameters<AgentDeps["actions"]["create"]>) => {
    const action = await deps.actions.create(...args);
    onProposal(action);
    return { proposed: action.title, actionId: action.id, status: "awaiting human approval; nothing was posted" };
  };

  return [
    {
      declaration: {
        name: "search_code",
        description:
          "Semantic + keyword search over the indexed repository. Returns matching code chunks with path and line range. Set include_docs to also search Markdown (READMEs, PRDs, notes).",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "What you are looking for, in words or identifiers." },
            path_prefix: { type: "STRING", description: "Optional folder to search in, e.g. backend/" },
            include_docs: { type: "BOOLEAN" },
          },
          required: ["query"],
        },
      },
      async run(args, repo) {
        const query = requiredString(args, "query");
        const [hits = []] = await deps.search.searchMany(repo, [query], {
          limit: 8,
          pathPrefix: optionalString(args, "path_prefix"),
          includeDocs: args.include_docs === true,
        });
        return hits.map((h) => ({
          location: `${h.path}:${h.start_line}-${h.end_line}`,
          symbol: h.symbol,
          kind: h.kind,
          content: h.content.slice(0, 1_500),
        }));
      },
    },
    {
      declaration: {
        name: "read_file",
        description: "Read a file from the repository's default branch, with line numbers. Use a line range for long files.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING" },
            start_line: { type: "INTEGER" },
            end_line: { type: "INTEGER" },
          },
          required: ["path"],
        },
      },
      async run(args, repo) {
        const path = requiredString(args, "path");
        const content = await deps.github.getFile(repo, path, "HEAD");
        if (content === null) throw new ToolInputError(`No file "${path}" on the default branch`);
        const lines = content.split("\n");
        const start = Math.max(1, typeof args.start_line === "number" ? Math.trunc(args.start_line) : 1);
        const end = Math.min(lines.length, typeof args.end_line === "number" ? Math.trunc(args.end_line) : start + MAX_FILE_LINES - 1);
        return {
          path,
          lines: `${start}-${end} of ${lines.length}`,
          content: lines
            .slice(start - 1, end)
            .map((l, i) => `${start + i}: ${l}`)
            .join("\n"),
        };
      },
    },
    {
      declaration: {
        name: "list_pull_requests",
        description: "List the repository's pull requests, most recently updated first.",
        parameters: {
          type: "OBJECT",
          properties: { state: { type: "STRING", enum: ["open", "closed", "all"] } },
        },
      },
      async run(args, repo) {
        const state = args.state === "closed" || args.state === "all" ? args.state : "open";
        const prs = await deps.github.listPullRequests(repo, state);
        return prs.slice(0, 20).map((p) => ({ number: p.number, title: p.title, author: p.author, state: p.state, url: p.url }));
      },
    },
    {
      declaration: {
        name: "get_pull_request",
        description: "Get a pull request's description and changed files, with diffs numbered by new-file line.",
        parameters: { type: "OBJECT", properties: { pr_number: { type: "INTEGER" } }, required: ["pr_number"] },
      },
      async run(args, repo) {
        const prNumber = requiredNumber(args, "pr_number");
        const [pr, files] = await Promise.all([
          deps.github.getPullRequest(repo, prNumber),
          deps.github.listPullRequestFiles(repo, prNumber),
        ]);
        let budget = MAX_DIFF_CHARS;
        return {
          number: pr.number,
          title: pr.title,
          author: pr.author,
          state: pr.state,
          branch: `${pr.headRef} → ${pr.baseRef}`,
          description: pr.body.slice(0, 4_000),
          files: files.map((f) => {
            const diff = f.patch ? annotatePatch(f.patch).text : null;
            const shown = diff && diff.length <= budget ? diff : null;
            if (shown) budget -= shown.length;
            return { path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, diff: shown ?? "(omitted: binary or over size budget)" };
          }),
        };
      },
    },
    {
      declaration: {
        name: "get_issue",
        description: "Get an issue's title, description, state and labels (e.g. the requirements a PR implements).",
        parameters: { type: "OBJECT", properties: { issue_number: { type: "INTEGER" } }, required: ["issue_number"] },
      },
      async run(args, repo) {
        const issueNumber = requiredNumber(args, "issue_number");
        const issue = await deps.github.getIssue(repo, issueNumber);
        if (!issue) throw new ToolInputError(`No issue #${issueNumber} (it may be a pull request)`);
        return { ...issue, body: issue.body.slice(0, 6_000) };
      },
    },
    {
      declaration: {
        name: "search_issues",
        description: 'Search the repository\'s issues with GitHub search syntax, e.g. "map markers is:open label:bug".',
        parameters: { type: "OBJECT", properties: { query: { type: "STRING" } }, required: ["query"] },
      },
      async run(args, repo) {
        const issues = await deps.github.searchIssues(repo, requiredString(args, "query"));
        return issues.slice(0, 15).map((i) => ({ number: i.number, title: i.title, state: i.state, labels: i.labels, url: i.url }));
      },
    },
    {
      declaration: {
        name: "analyze_dependencies",
        description:
          "With a path: the repo files and packages it imports, and the files that import it. Without a path: the repository's dependency manifests (package.json, pyproject.toml, requirements.txt...).",
        parameters: { type: "OBJECT", properties: { path: { type: "STRING" } } },
      },
      async run(args, repo) {
        const path = optionalString(args, "path");
        if (path) {
          const [own, importedBy] = await Promise.all([deps.dependencies.fileDeps(repo, path), deps.dependencies.dependents(repo, path)]);
          if (!own) throw new ToolInputError(`"${path}" is not in the index (not indexed yet, or not a source file)`);
          return { path, imports: own.imports, packages: own.packages, importedBy };
        }
        const manifests = (await deps.github.listFiles(repo, "HEAD"))
          .filter((p) => MANIFESTS.has(p.split("/").pop() ?? "") && !p.includes("node_modules/"))
          .sort()
          .slice(0, 6);
        const contents = await Promise.all(manifests.map((p) => deps.github.getFile(repo, p, "HEAD")));
        return { manifests: manifests.map((p, i) => ({ path: p, content: (contents[i] ?? "").slice(0, 3_000) })) };
      },
    },
    ...(deps.review ? [reviewTool(deps.review)] : []),
    {
      declaration: {
        name: "propose_pr_comment",
        description:
          "Propose a comment on a pull request. It is NOT posted: it waits for a human to approve it. Use only when the user asks for it or clearly wants it.",
        parameters: {
          type: "OBJECT",
          properties: { pr_number: { type: "INTEGER" }, body: { type: "STRING", description: "Markdown comment." } },
          required: ["pr_number", "body"],
        },
      },
      async run(args, repo) {
        const prNumber = requiredNumber(args, "pr_number");
        return propose(repo, `Comment on PR #${prNumber}`, { kind: "pr_comment", prNumber, body: requiredString(args, "body") });
      },
    },
    {
      declaration: {
        name: "propose_issue_update",
        description:
          "Propose a comment and/or labels on an issue. It is NOT applied: it waits for a human to approve it. Use only when the user asks for it or clearly wants it.",
        parameters: {
          type: "OBJECT",
          properties: {
            issue_number: { type: "INTEGER" },
            comment: { type: "STRING", description: "Markdown comment; omit for labels only." },
            add_labels: { type: "ARRAY", items: { type: "STRING" } },
          },
          required: ["issue_number"],
        },
      },
      async run(args, repo) {
        const issueNumber = requiredNumber(args, "issue_number");
        const comment = optionalString(args, "comment");
        const addLabels = Array.isArray(args.add_labels) ? args.add_labels.filter((l): l is string => typeof l === "string" && !!l.trim()) : [];
        if (!comment && !addLabels.length) throw new ToolInputError("Give a comment, labels, or both");
        return propose(repo, `Update issue #${issueNumber}`, { kind: "issue_update", issueNumber, comment, addLabels });
      },
    },
  ];
}

export function requiredNumber(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new ToolInputError(`"${name}" must be a positive integer`);
  return value;
}

export function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new ToolInputError(`"${name}" must be a non-empty string`);
  return value.trim();
}

export function optionalString(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function reviewTool(review: ReviewDeps): Tool {
  return {
    declaration: {
      name: "review_pull_request",
      description:
        "Run DevFlow's AI code review on a pull request (bugs, security, standards, tests, linked-issue requirements). Slow: use when asked to review.",
      parameters: { type: "OBJECT", properties: { pr_number: { type: "INTEGER" } }, required: ["pr_number"] },
    },
    async run(args, repo) {
      const r = await reviewPullRequest({ repo, prNumber: requiredNumber(args, "pr_number") }, review);
      return {
        verdict: r.verdict,
        summary: r.summary,
        requirements: r.requirements,
        findings: r.findings.map((f) => ({
          severity: f.severity,
          category: f.category,
          location: `${f.file}${f.line ? `:${f.line}` : ""}`,
          title: f.title,
          description: f.description,
          suggestion: f.suggestion,
          rule: f.rule,
        })),
        standardsApplied: r.standards.docs,
        notReviewed: r.skippedFiles,
      };
    },
  };
}
