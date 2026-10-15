// CLI: `npm run search -- "how are scenarios validated?" [path/prefix/] [--with-docs]`
// Searches code only by default; --with-docs also returns Markdown sections.

import { CodeSearch } from "../../shared/codeSearch";
import { Gemini } from "../../shared/gemini";
import { fetchWithTimeout } from "../../shared/net";
import { Supabase } from "../../shared/supabase";
import { loadConfig } from "./config";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const includeDocs = args.includes("--with-docs");
  const [query, pathPrefix] = args.filter((a) => !a.startsWith("--"));
  if (!query) throw new Error('Usage: npm run search -- "<question>" [path/prefix/] [--with-docs]');

  const config = loadConfig({ REPO_DIR: ".", ...process.env });
  const fetchFn = fetchWithTimeout(fetch, config.requestTimeoutMs);
  const gemini = new Gemini(
    {
      apiKey: config.geminiApiKey,
      model: "unused-by-search",
      embeddingModel: config.embeddingModel,
      maxRetries: 2,
      embedTextsPerMinute: config.embedTextsPerMinute,
    },
    { fetch: fetchFn, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log: console.log, now: Date.now },
  );
  const search = new CodeSearch(new Supabase(config.supabaseUrl, config.supabaseServiceKey, fetchFn), gemini);

  const hits = await search.search(config.repo, query, { limit: 8, pathPrefix: pathPrefix ?? null, includeDocs });
  for (const h of hits) {
    console.log(`\n${h.score.toFixed(4)}  ${h.path}:${h.start_line}-${h.end_line}  ${h.kind} ${h.symbol ?? ""}`);
    console.log(h.content.split("\n").slice(0, 4).map((l) => `    ${l}`).join("\n"));
  }
  if (!hits.length) console.log("No results. Has the repo been indexed?");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
