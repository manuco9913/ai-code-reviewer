// Cloudflare Worker entry point: wires adapters to modules and routes requests and queue messages.

import { CodeSearch } from "../../shared/codeSearch";
import { Gemini } from "../../shared/gemini";
import { fetchWithTimeout } from "../../shared/net";
import { Supabase } from "../../shared/supabase";
import { ActionConflictError, ActionNotFoundError, decideAction } from "./actions/actions";
import { ChatInputError, parseChatRequest, runAgent } from "./agent/agent";
import { approvalResponse } from "./actions/approvalPage";
import { reviewJobFor, type ReviewJob } from "./automation/events";
import { runReviewJob } from "./automation/reviewJob";
import { loadConfig, type AutomationConfig, type Env, type WorkerConfig } from "./config";
import { GitHubClient } from "./github/client";
import { HttpError, isAuthorized, json, readJson } from "./http";
import { ResendMailer } from "./mailer";
import { reviewPullRequest } from "./review/reviewer";
import { verifyGitHubSignature } from "./security";
import { SupabaseActionStore, SupabaseDependencyIndex, SupabaseReviewStore } from "./stores";

const APPROVAL_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return json({ ok: true });
      const config = loadConfig(env);
      const services = createServices(config);

      if (url.pathname === "/webhooks/github" && request.method === "POST") {
        return await handleWebhook(request, requireAutomation(config), env);
      }

      const actionPage = /^\/actions\/([\w-]+)$/.exec(url.pathname);
      if (actionPage?.[1] && (request.method === "GET" || request.method === "POST")) {
        const automation = requireAutomation(config);
        const form = request.method === "POST" ? await request.formData() : null;
        const decision = form?.get("decision");
        const page = await approvalResponse(
          {
            method: request.method,
            actionId: actionPage[1],
            token: String(form?.get("token") ?? url.searchParams.get("token") ?? ""),
            decision: decision === "approve" || decision === "reject" ? decision : null,
          },
          { store: services.actions, github: services.github, secret: automation.approvalSecret, now: Date.now },
        );
        return new Response(page.html, {
          status: page.status,
          headers: { "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer" },
        });
      }

      if (url.pathname.startsWith("/api/")) {
        if (!isAuthorized(request, config.apiToken)) throw new HttpError(401, "Unauthorized");
        return await handleApi(request, url, services);
      }

      throw new HttpError(404, "Not found");
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
    }
  },

  /** Queue consumer: one review per message. Failed messages are retried by the queue. */
  async queue(batch: MessageBatch<ReviewJob>, env: Env): Promise<void> {
    const config = loadConfig(env);
    const automation = requireAutomation(config);
    const services = createServices(config);
    for (const message of batch.messages) {
      try {
        const outcome = await runReviewJob(message.body, {
          review: services.reviewDeps,
          reviews: services.reviews,
          actions: services.actions,
          mailer: new ResendMailer(automation.resendApiKey, automation.emailFrom, automation.emailTo, services.dataFetch),
          links: { baseUrl: automation.publicUrl, secret: automation.approvalSecret, ttlMs: APPROVAL_LINK_TTL_MS, now: Date.now },
        });
        console.log(`${message.body.repo}#${message.body.prNumber}: ${outcome.status}`);
        message.ack();
      } catch (err) {
        console.error(`Review job failed for ${message.body.repo}#${message.body.prNumber}`, err);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, ReviewJob>;

async function handleWebhook(request: Request, automation: AutomationConfig, env: Env): Promise<Response> {
  const body = await request.text();
  if (!(await verifyGitHubSignature(body, request.headers.get("x-hub-signature-256"), automation.webhookSecret))) {
    throw new HttpError(401, "Bad signature");
  }
  const event = request.headers.get("x-github-event") ?? "";
  if (event === "ping") return json({ ok: true, pong: true });

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
  const job = reviewJobFor(event, payload);
  if (!job) return json({ ignored: event }, 202);
  if (!env.REVIEW_QUEUE) throw new HttpError(503, "REVIEW_QUEUE binding is missing (see wrangler.toml)");
  await env.REVIEW_QUEUE.send(job);
  return json({ queued: job }, 202);
}

async function handleApi(request: Request, url: URL, s: Services): Promise<Response> {
  if (request.method === "POST" && url.pathname === "/api/review") {
    const body = await readJson(request);
    const repo = typeof body.repo === "string" ? body.repo : "";
    const prNumber = typeof body.prNumber === "number" ? body.prNumber : NaN;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(prNumber) || prNumber < 1) {
      throw new HttpError(400, 'Expected {"repo": "owner/name", "prNumber": 123}');
    }
    return json(await reviewPullRequest({ repo, prNumber }, s.reviewDeps));
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    let chat;
    try {
      chat = parseChatRequest(await readJson(request));
    } catch (err) {
      if (err instanceof ChatInputError) throw new HttpError(400, err.message);
      throw err;
    }
    return json(
      await runAgent(chat, {
        model: s.agentGemini,
        github: s.github,
        search: s.reviewDeps.search,
        actions: s.actions,
        dependencies: s.dependencies,
        review: s.reviewDeps,
      }),
    );
  }

  if (request.method === "GET" && url.pathname === "/api/actions") {
    const status = url.searchParams.get("status") ?? "pending";
    if (!["pending", "approved", "rejected", "executed", "failed"].includes(status)) throw new HttpError(400, "Unknown status");
    return json(await s.actions.list(status as "pending"));
  }

  const decide = /^\/api\/actions\/([\w-]+)\/(approve|reject)$/.exec(url.pathname);
  if (request.method === "POST" && decide?.[1] && decide[2]) {
    try {
      return json(await decideAction(decide[1], decide[2] as "approve" | "reject", { store: s.actions, github: s.github }));
    } catch (err) {
      if (err instanceof ActionConflictError) throw new HttpError(409, err.message);
      if (err instanceof ActionNotFoundError) throw new HttpError(404, err.message);
      throw err;
    }
  }

  throw new HttpError(404, "Not found");
}

function requireAutomation(config: WorkerConfig): AutomationConfig {
  if (!config.automation) throw new HttpError(503, "Automation is not configured (see docs/setup.md)");
  return config.automation;
}

type Services = ReturnType<typeof createServices>;

function createServices(config: WorkerConfig) {
  // Generation can take a while on large reviews; data APIs should answer quickly.
  const geminiFetch = fetchWithTimeout(fetch, 120_000);
  const dataFetch = fetchWithTimeout(fetch, 20_000);
  const geminiDeps = {
    fetch: geminiFetch,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    log: console.log,
    now: Date.now,
  };
  const reviewModel = {
    apiKey: config.geminiApiKey,
    model: config.geminiModel,
    embeddingModel: config.embeddingModel,
    maxRetries: 2,
    fallbackModels: config.geminiFallbackModels,
    thinkingLevel: config.geminiThinkingLevel,
    embedTextsPerMinute: 100,
  };
  const gemini = new Gemini(reviewModel, geminiDeps);
  // Chat is interactive: a fast model first, the review model as the fallback.
  const agentGemini = new Gemini(
    {
      ...reviewModel,
      model: config.geminiAgentModel,
      fallbackModels: [config.geminiModel, ...config.geminiFallbackModels].filter((m) => m !== config.geminiAgentModel),
    },
    geminiDeps,
  );
  const db = new Supabase(config.supabaseUrl, config.supabaseServiceKey, dataFetch);
  const github = new GitHubClient(config.githubToken, dataFetch);
  return {
    dataFetch,
    gemini,
    agentGemini,
    github,
    dependencies: new SupabaseDependencyIndex(db),
    actions: new SupabaseActionStore(db),
    reviews: new SupabaseReviewStore(db),
    reviewDeps: { github, search: new CodeSearch(db, gemini), model: gemini },
  };
}
