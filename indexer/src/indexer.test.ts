import { describe, expect, it } from "vitest";
import { indexRepository, type Embedder, type FileRecord, type IndexStore, type StoredChunk } from "./indexer";

/** In-memory stand-in for the Supabase index (a system boundary). */
class MemoryStore implements IndexStore {
  files = new Map<string, FileRecord>();
  chunks: StoredChunk[] = [];
  runs: { commit: string; fileCount: number }[] = [];

  async getIndexedFiles() {
    return new Map(this.files);
  }
  async replaceFiles(_repo: string, entries: { file: FileRecord; chunks: StoredChunk[] }[]) {
    for (const { file, chunks } of entries) {
      this.chunks = this.chunks.filter((c) => c.path !== file.path).concat(chunks);
      this.files.set(file.path, file);
    }
  }
  async updateFileImports(_repo: string, files: FileRecord[]) {
    for (const f of files) this.files.set(f.path, f);
  }
  async deleteFiles(_repo: string, paths: string[]) {
    this.chunks = this.chunks.filter((c) => !paths.includes(c.path));
    for (const p of paths) this.files.delete(p);
  }
  async recordRun(_repo: string, run: { commit: string; fileCount: number }) {
    this.runs.push(run);
  }
}

/** Deterministic embedder (Gemini is a system boundary); remembers what it was asked to embed. */
class FakeEmbedder implements Embedder {
  embedded: string[] = [];
  async embedDocuments(texts: string[]) {
    this.embedded.push(...texts);
    return texts.map((t) => [t.length, 1]);
  }
}

const run = (files: { path: string; content: string }[], store: MemoryStore, embedder: FakeEmbedder) =>
  indexRepository({ repo: "me/app", commit: "abc", files }, { store, embedder, log: () => {} });

describe("indexRepository", () => {
  it("stores embedded chunks for each source file, with path and symbol in the embedded text", async () => {
    const store = new MemoryStore();
    const embedder = new FakeEmbedder();

    await run([{ path: "src/math.ts", content: "export function add(a: number, b: number) {\n  return a + b;\n}\n" }], store, embedder);

    expect(store.chunks).toEqual([
      expect.objectContaining({ path: "src/math.ts", symbol: "add", kind: "function", language: "typescript", startLine: 1, endLine: 3 }),
    ]);
    expect(store.chunks[0]?.embedding).toHaveLength(2);
    expect(embedder.embedded[0]).toContain("src/math.ts");
    expect(embedder.embedded[0]).toContain("add");
  });

  it("re-embeds only files whose content changed since the last run", async () => {
    const store = new MemoryStore();
    const a = { path: "src/a.ts", content: "export function a() {}\n" };
    const b = { path: "src/b.ts", content: "export function b() {}\n" };
    await run([a, b], store, new FakeEmbedder());

    const embedder = new FakeEmbedder();
    const result = await run([a, { ...b, content: "export function b2() {}\n" }], store, embedder);

    expect(embedder.embedded).toHaveLength(1);
    expect(embedder.embedded[0]).toContain("b2");
    expect(result).toMatchObject({ indexedFiles: 1, unchangedFiles: 1 });
    expect(store.chunks.map((c) => c.symbol).sort()).toEqual(["a", "b2"]);
  });

  it("removes files that no longer exist in the repository", async () => {
    const store = new MemoryStore();
    const a = { path: "src/a.ts", content: "export function a() {}\n" };
    await run([a, { path: "src/old.ts", content: "export function old() {}\n" }], store, new FakeEmbedder());

    const result = await run([a], store, new FakeEmbedder());

    expect(result.deletedFiles).toBe(1);
    expect(store.chunks.map((c) => c.path)).toEqual(["src/a.ts"]);
    expect([...store.files.keys()]).toEqual(["src/a.ts"]);
  });

  it("indexes source, docs and config, but skips vendored, built, minified, lock and oversized files", async () => {
    const store = new MemoryStore();
    const code = "export const x = 1;\n";
    const files = [
      { path: "src/app.tsx", content: code },
      { path: "backend/app/main.py", content: "x = 1\n" },
      { path: "README.md", content: "# Hi\n" },
      { path: ".github/workflows/ci.yml", content: "on: push\n" },
      { path: "Dockerfile", content: "FROM node:22\n" },
      { path: "node_modules/react/index.js", content: code },
      { path: "frontend/dist/bundle.js", content: code },
      { path: "public/vendor/lib.min.js", content: code },
      { path: "package-lock.json", content: "{}" },
      { path: "pnpm-lock.yaml", content: "lockfileVersion: 9\n" },
      { path: "src/minified.js", content: "x".repeat(5000) },
      { path: "src/generated.ts", content: "export const a = 1;\n".repeat(20_000) },
      { path: "assets/logo.png", content: "\u0000PNG" },
    ];

    await run(files, store, new FakeEmbedder());

    expect([...store.files.keys()].sort()).toEqual([
      ".github/workflows/ci.yml",
      "Dockerfile",
      "README.md",
      "backend/app/main.py",
      "src/app.tsx",
    ]);
  });

  it("refreshes the import graph of unchanged files without re-embedding them", async () => {
    const store = new MemoryStore();
    const a = { path: "src/a.ts", content: "import { b } from './b';\nexport const a = b;\n" };
    await run([a], store, new FakeEmbedder());

    const embedder = new FakeEmbedder();
    await run([a, { path: "src/b.ts", content: "export const b = 1;\n" }], store, embedder);

    expect(store.files.get("src/a.ts")?.imports).toEqual(["src/b.ts"]);
    expect(embedder.embedded.every((t) => t.includes("src/b.ts"))).toBe(true);
  });
});
