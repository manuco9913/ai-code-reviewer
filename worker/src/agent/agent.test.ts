import { describe, expect, it } from "vitest";
import { call, FakeGitHub, FakeModel, FakeSearch, finding, MemoryActionStore, modelAnswer, ScriptedModel, say } from "../testing/fakes";
import { parseChatRequest, runAgent, type AgentDeps } from "./agent";

function deps(model: ScriptedModel, overrides: Partial<AgentDeps> = {}): AgentDeps {
  return {
    model,
    github: new FakeGitHub(),
    search: new FakeSearch(),
    actions: new MemoryActionStore(),
    dependencies: { fileDeps: async () => null, dependents: async () => [] },
    review: null,
    ...overrides,
  };
}

describe("runAgent", () => {
  it("returns the model's answer for a question it can answer directly", async () => {
    const model = new ScriptedModel([say("DevFlow reviews pull requests.")]);

    const result = await runAgent({ repo: "me/app", messages: [{ role: "user", text: "What do you do?" }] }, deps(model));

    expect(result.reply).toBe("DevFlow reviews pull requests.");
    expect(result.steps).toEqual([]);
    expect(model.requests[0]?.system).toContain("me/app");
  });

  it("runs the tools the model asks for and gives it the results before it answers", async () => {
    const search = new FakeSearch();
    search.hits = [
      { id: 1, path: "src/price.ts", symbol: "price", kind: "function", language: "typescript", start_line: 1, end_line: 4, content: "export function price(p: number) {}", score: 0.03 },
    ];
    const model = new ScriptedModel([call("search_code", { query: "how are prices computed" }), say("See src/price.ts:1.")]);

    const result = await runAgent({ repo: "me/app", messages: [{ role: "user", text: "Where is pricing?" }] }, deps(model, { search }));

    expect(result.reply).toBe("See src/price.ts:1.");
    expect(result.steps).toEqual([{ tool: "search_code", args: { query: "how are prices computed" }, ok: true }]);
    const toolTurn = model.requests[1]?.contents.at(-1);
    expect(JSON.stringify(toolTurn)).toContain("src/price.ts");
    expect(JSON.stringify(toolTurn)).toContain("functionResponse");
  });

  it("stops calling tools after the turn limit and makes the model answer with what it has", async () => {
    const endless = Array.from({ length: 8 }, () => call("search_code", { query: "again" }));
    const model = new ScriptedModel([...endless, say("Best answer so far.")]);

    const result = await runAgent({ repo: "me/app", messages: [{ role: "user", text: "Find everything" }] }, deps(model));

    expect(result.reply).toBe("Best answer so far.");
    expect(result.steps).toHaveLength(8);
    expect(model.requests.at(-1)?.toolMode).toBe("NONE");
  });

  it("reports a failing or unknown tool to the model instead of failing the chat", async () => {
    const search = new FakeSearch();
    search.searchMany = async () => {
      throw new Error("index unavailable");
    };
    const model = new ScriptedModel([call("search_code", { query: "x" }), call("delete_repo", {}), say("Search is down.")]);

    const result = await runAgent({ repo: "me/app", messages: [{ role: "user", text: "Find x" }] }, deps(model, { search }));

    expect(result.reply).toBe("Search is down.");
    expect(result.steps.map((s) => [s.tool, s.ok])).toEqual([["search_code", false], ["delete_repo", false]]);
    expect(JSON.stringify(model.requests[1]?.contents.at(-1))).toContain("index unavailable");
    expect(JSON.stringify(model.requests[2]?.contents.at(-1))).toContain('Unknown tool');
  });

  it("turns requested GitHub updates into proposals awaiting approval, never direct writes", async () => {
    const actions = new MemoryActionStore();
    const model = new ScriptedModel([
      call("propose_issue_update", { issue_number: 12, comment: "Blocked on #5.", add_labels: ["blocked"] }),
      call("propose_pr_comment", { pr_number: 5, body: "Please add a test for members." }),
      say("I've proposed both updates; approve them to post."),
    ]);

    const result = await runAgent({ repo: "me/app", messages: [{ role: "user", text: "Flag it" }] }, deps(model, { actions }));

    const pending = await actions.list("pending");
    expect(pending.map((a) => a.payload)).toEqual([
      { kind: "issue_update", issueNumber: 12, comment: "Blocked on #5.", addLabels: ["blocked"] },
      { kind: "pr_comment", prNumber: 5, body: "Please add a test for members." },
    ]);
    expect(result.proposals.map((p) => p.id)).toEqual(pending.map((a) => a.id));
  });
});

/** Runs one tool call through the agent and returns what the model was given back. */
async function toolResult(name: string, args: Record<string, unknown>, overrides: Partial<AgentDeps> = {}) {
  const model = new ScriptedModel([call(name, args), say("done")]);
  await runAgent({ repo: "me/app", messages: [{ role: "user", text: "go" }] }, deps(model, overrides));
  const parts = model.requests[1]?.contents.at(-1)?.parts ?? [];
  return (parts[0] as { functionResponse?: { response: Record<string, unknown> } }).functionResponse?.response;
}

describe("agent tools", () => {
  it("read_file returns numbered lines from the default branch, optionally a range", async () => {
    const github = new FakeGitHub();
    github.trees.set("HEAD", { "src/a.ts": ["line one", "line two", "line three", "line four"].join("\n") });

    expect(await toolResult("read_file", { path: "src/a.ts", start_line: 2, end_line: 3 }, { github })).toEqual({
      result: { path: "src/a.ts", lines: "2-3 of 4", content: "2: line two\n3: line three" },
    });
    expect(await toolResult("read_file", { path: "missing.ts" }, { github })).toEqual({ error: 'No file "missing.ts" on the default branch' });
  });

  it("get_pull_request returns the PR with its line-numbered diff", async () => {
    const result = await toolResult("get_pull_request", { pr_number: 5 });

    expect(result).toMatchObject({ result: { number: 5, title: "Add discount calculation", files: [{ path: "src/price.ts" }] } });
    expect(JSON.stringify(result)).toContain("2 +   const d = p * 0.1;");
  });

  it("list_pull_requests summarises PRs", async () => {
    expect(await toolResult("list_pull_requests", { state: "open" })).toEqual({
      result: [{ number: 5, title: "Add discount calculation", author: "dev", state: "open", url: "https://github.com/me/app/pull/5" }],
    });
  });

  it("get_issue and search_issues read issues, as requirements context", async () => {
    const github = new FakeGitHub();
    github.issues.set(12, { number: 12, title: "Member discounts", body: "Members get 10% off.", state: "open", labels: ["pricing"], url: "u12" });

    expect(await toolResult("get_issue", { issue_number: 12 }, { github })).toMatchObject({ result: { title: "Member discounts", labels: ["pricing"] } });
    expect(await toolResult("get_issue", { issue_number: 99 }, { github })).toEqual({ error: "No issue #99 (it may be a pull request)" });
    expect(await toolResult("search_issues", { query: "discount" }, { github })).toMatchObject({ result: [{ number: 12 }] });
  });

  it("analyze_dependencies shows a file's imports and dependents, or the repo's manifests", async () => {
    const dependencies = {
      fileDeps: async (_repo: string, path: string) => (path === "src/price.ts" ? { imports: ["src/rates.ts"], packages: ["zod"] } : null),
      dependents: async () => ["src/cart.ts", "src/price.test.ts"],
    };
    const github = new FakeGitHub();
    github.trees.set("HEAD", { "frontend/package.json": '{"dependencies":{"react":"^19"}}', "backend/pyproject.toml": "[project]", "src/a.ts": "" });

    expect(await toolResult("analyze_dependencies", { path: "src/price.ts" }, { dependencies })).toEqual({
      result: { path: "src/price.ts", imports: ["src/rates.ts"], packages: ["zod"], importedBy: ["src/cart.ts", "src/price.test.ts"] },
    });
    expect(await toolResult("analyze_dependencies", {}, { github })).toMatchObject({
      result: { manifests: [{ path: "backend/pyproject.toml" }, { path: "frontend/package.json", content: expect.stringContaining("react") }] },
    });
  });

  it("review_pull_request runs the reviewer and returns its findings", async () => {
    const reviewModel = new FakeModel(modelAnswer([finding({ line: 2 })]));
    const review = { github: new FakeGitHub(), search: new FakeSearch(), model: reviewModel };

    expect(await toolResult("review_pull_request", { pr_number: 5 }, { review })).toMatchObject({
      result: { verdict: "comment", findings: [{ severity: "medium", location: "src/price.ts:2", title: "Hard-coded discount" }] },
    });
  });
});

describe("parseChatRequest", () => {
  it("accepts a repo and a conversation ending with the user's message", () => {
    expect(
      parseChatRequest({ repo: "me/app", messages: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }, { role: "user", text: "where?" }] }),
    ).toEqual({ repo: "me/app", messages: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }, { role: "user", text: "where?" }] });
  });

  it("rejects malformed input with a reason", () => {
    expect(() => parseChatRequest({ repo: "not a repo", messages: [{ role: "user", text: "x" }] })).toThrow(/repo/);
    expect(() => parseChatRequest({ repo: "me/app", messages: [] })).toThrow(/messages/);
    expect(() => parseChatRequest({ repo: "me/app", messages: [{ role: "system", text: "x" }] })).toThrow(/role/);
    expect(() => parseChatRequest({ repo: "me/app", messages: [{ role: "user", text: "x".repeat(20_001) }] })).toThrow(/too long/);
    expect(() => parseChatRequest({ repo: "me/app", messages: [{ role: "assistant", text: "x" }] })).toThrow(/last message/);
  });

  it("keeps only the most recent part of a long conversation", () => {
    const messages = Array.from({ length: 41 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `m${i}` }));
    const parsed = parseChatRequest({ repo: "me/app", messages });
    expect(parsed.messages).toHaveLength(19); // last 20, minus a leading assistant turn
    expect(parsed.messages[0]).toEqual({ role: "user", text: "m22" });
  });
});
