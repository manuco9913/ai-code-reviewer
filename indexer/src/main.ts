// Entry point: index a checked-out repository. Run by .github/workflows/index-repo.yml.

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Gemini } from "../../shared/gemini";
import { fetchWithTimeout } from "../../shared/net";
import { Supabase } from "../../shared/supabase";
import { loadConfig } from "./config";
import { indexRepository, type RepoFile } from "./indexer";
import { SupabaseIndexStore } from "./supabaseStore";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const git = (...args: string[]) => execFileSync("git", ["-C", config.repoDir, ...args], { encoding: "utf8" });

  const commit = git("rev-parse", "HEAD").trim();
  // Tracked files only, so .gitignore'd build output and secrets never get indexed.
  const paths = git("ls-files", "-z").split("\0").filter(Boolean);
  const files: RepoFile[] = [];
  for (const path of paths) {
    try {
      files.push({ path, content: await readFile(join(config.repoDir, path), "utf8") });
    } catch {
      // Submodules and broken symlinks are listed but unreadable; skip them.
    }
  }

  const fetchFn = fetchWithTimeout(fetch, config.requestTimeoutMs);
  const gemini = new Gemini(
    {
      apiKey: config.geminiApiKey,
      model: "unused-by-indexer",
      embeddingModel: config.embeddingModel,
      maxRetries: 6,
      embedTextsPerMinute: config.embedTextsPerMinute,
    },
    { fetch: fetchFn, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log: console.log, now: Date.now },
  );
  const store = new SupabaseIndexStore(new Supabase(config.supabaseUrl, config.supabaseServiceKey, fetchFn));

  console.log(`Indexing ${config.repo}@${commit.slice(0, 7)} (${files.length} tracked files)`);
  const result = await indexRepository({ repo: config.repo, commit, files }, { store, embedder: gemini, log: console.log });
  console.log(
    `Done: ${result.indexedFiles} re-indexed, ${result.unchangedFiles} unchanged, ${result.deletedFiles} removed, ${result.chunks} chunks written`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
