// Cloudflare Worker entry point: wires adapters to modules and routes requests.

import { CodeSearch } from "../../shared/codeSearch";
import { Gemini } from "../../shared/gemini";
import { Supabase } from "../../shared/supabase";
import { loadConfig, type Env, type WorkerConfig } from "./config";
import { GitHubClient } from "./github/client";
import { HttpError, isAuthorized, json, readJson } from "./http";
import { reviewPullRequest, type ReviewDeps } from "./review/reviewer";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return json({ ok: true });

      const config = loadConfig(env);
      if (url.pathname.startsWith("/api/") && !isAuthorized(request, config.apiToken)) {
        throw new HttpError(401, "Unauthorized");
      }

      if (request.method === "POST" && url.pathname === "/api/review") {
        const body = await readJson(request);
        const repo = typeof body.repo === "string" ? body.repo : "";
        const prNumber = typeof body.prNumber === "number" ? body.prNumber : NaN;
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(prNumber) || prNumber < 1) {
          throw new HttpError(400, 'Expected {"repo": "owner/name", "prNumber": 123}');
        }
        return json(await reviewPullRequest({ repo, prNumber }, reviewDeps(config)));
      }

      throw new HttpError(404, "Not found");
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
    }
  },
};

function reviewDeps(config: WorkerConfig): ReviewDeps {
  const gemini = new Gemini(
    { apiKey: config.geminiApiKey, model: config.geminiModel, embeddingModel: config.embeddingModel, maxRetries: 2 },
    { fetch, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
  );
  const db = new Supabase(config.supabaseUrl, config.supabaseServiceKey, fetch);
  return { github: new GitHubClient(config.githubToken, fetch), search: new CodeSearch(db, gemini), model: gemini };
}
