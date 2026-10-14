import { describe, expect, it } from "vitest";
import { chunkFile } from "./chunker";

const summary = (chunks: ReturnType<typeof chunkFile>) =>
  chunks.map((c) => ({ kind: c.kind, symbol: c.symbol, lines: [c.startLine, c.endLine] }));

describe("chunkFile — TypeScript", () => {
  it("turns a top-level function into one function chunk with its line range", () => {
    const src = ["import { x } from './x';", "", "export function add(a: number, b: number) {", "  return a + b;", "}", ""].join("\n");

    expect(summary(chunkFile("src/math.ts", src, "typescript"))).toContainEqual({
      kind: "function",
      symbol: "add",
      lines: [3, 5],
    });
  });

  it("keeps imports and other top-level statements in a module chunk so nothing is unindexed", () => {
    const src = ["import { x } from './x';", "const LIMIT = 10;", "", "function f() {", "  return LIMIT;", "}"].join("\n");

    expect(summary(chunkFile("src/a.ts", src, "typescript"))).toEqual([
      { kind: "module", symbol: null, lines: [1, 2] },
      { kind: "function", symbol: "f", lines: [4, 6] },
    ]);
  });

  it("recognises arrow-function constants, classes and type declarations", () => {
    const src = [
      "export const handler = async (req: Request) => {", // 1
      "  return new Response('ok');",
      "};",
      "export class Store {", // 4
      "  get() { return 1; }",
      "}",
      "export interface User { id: string }", // 7
      "type Id = string;", // 8
      "enum Color { Red }", // 9
    ].join("\n");

    expect(summary(chunkFile("src/a.ts", src, "typescript"))).toEqual([
      { kind: "function", symbol: "handler", lines: [1, 3] },
      { kind: "class", symbol: "Store", lines: [4, 6] },
      { kind: "type", symbol: "User", lines: [7, 7] },
      { kind: "type", symbol: "Id", lines: [8, 8] },
      { kind: "type", symbol: "Color", lines: [9, 9] },
    ]);
  });

  it("includes the leading doc comment in the declaration's chunk", () => {
    const src = ["const a = 1;", "", "/**", " * Adds numbers.", " */", "// fast path", "function add() {}"].join("\n");

    const add = chunkFile("src/a.ts", src, "typescript").find((c) => c.symbol === "add");

    expect(add?.startLine).toBe(3);
    expect(add?.content).toContain("Adds numbers.");
  });

  it("splits a large class into one chunk per method, named Class.method", () => {
    const body = (n: number) => Array.from({ length: n }, (_, i) => `    const v${i} = ${i};`);
    const src = [
      "export class Repo {", // 1
      "  private cache = new Map();", // 2
      "  load(id: string) {", // 3
      ...body(80), // 4-83
      "  }", // 84
      "  save() {", // 85
      ...body(80), // 86-165
      "  }", // 166
      "}", // 167
    ].join("\n");

    const chunks = summary(chunkFile("src/repo.ts", src, "typescript"));

    expect(chunks).toContainEqual({ kind: "method", symbol: "Repo.load", lines: [3, 84] });
    expect(chunks).toContainEqual({ kind: "method", symbol: "Repo.save", lines: [85, 166] });
    expect(chunks).toContainEqual({ kind: "class", symbol: "Repo", lines: [1, 2] });
  });

  it("splits an oversized function into overlapping windows that cover all of it", () => {
    const src = ["function big() {", ...Array.from({ length: 298 }, (_, i) => `  call(${i});`), "}"].join("\n");

    const chunks = chunkFile("src/big.ts", src, "typescript");

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.symbol === "big" && c.endLine - c.startLine + 1 <= 120)).toBe(true);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks.at(-1)?.endLine).toBe(300);
    chunks.slice(1).forEach((c, i) => expect(c.startLine).toBeLessThanOrEqual(chunks[i]?.endLine ?? 0));
  });

  it("names multi-line top-level calls such as test suites and route registrations", () => {
    const src = [
      "import { geo } from './geo';", // 1
      "", // 2
      "describe('haversineKm', () => {", // 3
      "  it('is zero for the same point', () => {", // 4
      "    expect(geo(1, 1)).toBe(0);", // 5
      "  });", // 6
      "});", // 7
      "app.get('/health', (req, res) => {", // 8
      "  res.send('ok');", // 9
      "});", // 10
    ].join("\n");

    expect(summary(chunkFile("src/geo.test.ts", src, "typescript"))).toEqual([
      { kind: "module", symbol: null, lines: [1, 1] },
      { kind: "block", symbol: 'describe("haversineKm")', lines: [3, 7] },
      { kind: "block", symbol: 'app.get("/health")', lines: [8, 10] },
    ]);
  });
});

describe("chunkFile — Python", () => {
  it("chunks a decorated top-level function, including a multi-line signature", () => {
    const src = [
      "import os", // 1
      "", // 2
      "@app.get('/items')", // 3
      "def list_items(", // 4
      "    limit: int,", // 5
      "):", // 6
      "    return []", // 7
      "", // 8
      "TIMEOUT = 5", // 9
    ].join("\n");

    expect(summary(chunkFile("app/main.py", src, "python"))).toEqual([
      { kind: "module", symbol: null, lines: [1, 1] },
      { kind: "function", symbol: "list_items", lines: [3, 7] },
      { kind: "module", symbol: null, lines: [9, 9] },
    ]);
  });

  it("splits a large class into one chunk per method, named Class.method", () => {
    const body = (n: number) => Array.from({ length: n }, (_, i) => `        x${i} = ${i}`);
    const src = [
      "class Repo:", // 1
      "    cache = {}", // 2
      "", // 3
      "    @staticmethod", // 4
      "    def load(id):", // 5
      ...body(80), // 6-85
      "    async def save(self):", // 86
      ...body(80), // 87-166
    ].join("\n");

    const chunks = summary(chunkFile("app/repo.py", src, "python"));

    expect(chunks).toEqual([
      { kind: "class", symbol: "Repo", lines: [1, 2] },
      { kind: "method", symbol: "Repo.load", lines: [4, 85] },
      { kind: "method", symbol: "Repo.save", lines: [86, 166] },
    ]);
  });
});

describe("chunkFile — other files", () => {
  it("splits markdown into sections named by their heading", () => {
    const src = ["Intro text", "", "## Setup", "Run it.", "", "### Env vars", "Set KEY.", "", "## Usage", "Go."].join("\n");

    expect(summary(chunkFile("README.md", src, "markdown"))).toEqual([
      { kind: "section", symbol: null, lines: [1, 2] },
      { kind: "section", symbol: "Setup", lines: [3, 5] },
      { kind: "section", symbol: "Env vars", lines: [6, 8] },
      { kind: "section", symbol: "Usage", lines: [9, 10] },
    ]);
  });

  it("windows plain text files so every line is indexed", () => {
    const src = Array.from({ length: 200 }, (_, i) => `key${i}: ${i}`).join("\n");

    const chunks = chunkFile("config.yml", src, "text");

    expect(chunks[0]).toMatchObject({ kind: "block", startLine: 1 });
    expect(chunks.at(-1)?.endLine).toBe(200);
  });
});
