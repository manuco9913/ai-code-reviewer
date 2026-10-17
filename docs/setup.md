# Setup

All services below have a free tier that covers personal use. Accounts are added as the build
progresses; this page covers what the current step needs.

| Step | Needs |
|---|---|
| 1–2. Index + search (now) | Gemini API key, Supabase project |
| 2b. Index from GitHub Actions | This repo pushed to GitHub, a fine-grained PAT |
| 5. Reviewer locally | A GitHub token with read access |
| 6. Automated reviews | Cloudflare account, Resend account, a GitHub webhook |

> **Privacy note — read before indexing private code.** On Gemini's *free* tier, Google may use
> prompts and responses to improve its products. Indexing and reviewing a repository sends its code
> to Gemini. Fine for open-source or personal projects; for code you can't share, enable billing
> on the Google AI project (paid tier data isn't used for training) or don't index it.

## 1. Gemini API key

1. Go to <https://aistudio.google.com/apikey> and sign in with a Google account.
2. **Create API key** → copy it. This is `GEMINI_API_KEY`.

Free-tier limits change; check the current numbers at <https://ai.google.dev/gemini-api/docs/rate-limits>.
The indexer retries rate-limited calls and only re-embeds changed files, so a re-run is cheap.

## 2. Supabase project

1. Sign up at <https://supabase.com> → **New project**. Pick a region near you, save the DB
   password somewhere (you won't need it day to day).
2. **SQL Editor** → **New query** → paste all of [`supabase/schema.sql`](../supabase/schema.sql) → **Run**.
   It is safe to run again after schema updates.
3. **Project Settings → API Keys**: copy the **secret** key (`sb_secret_...`; on older projects the
   `service_role` key). This is `SUPABASE_SERVICE_KEY`. Never put it in frontend code.
4. **Project Settings → Data API**: copy the project URL (`https://xxxx.supabase.co`). This is `SUPABASE_URL`.

Free projects pause after about a week without activity; the nightly index run keeps it awake.

## 3. Index a repository from your machine

The indexer runs no model locally — it only reads files and calls the APIs — so it is fine on a
small machine.

```powershell
copy .env.example .env      # then edit .env: REPO, REPO_DIR, SUPABASE_*, GEMINI_API_KEY
npm install
npm run index
```

`REPO` is the GitHub `owner/name` (it labels the index); `REPO_DIR` is the local clone. Only
git-tracked files are read, so ignored files and secrets in `.env` files are never indexed.

Then try a few questions:

```powershell
npm run search -- "where are scenario files validated?"
npm run search -- "map markers" frontend/
npm run search -- "scenario requirements" --with-docs   # include Markdown (PRDs, READMEs)
```

## 4. Index from GitHub Actions (keeps the index fresh)

1. Push this repo to GitHub (it can be private).
2. Create a **fine-grained personal access token**: GitHub → Settings → Developer settings →
   Fine-grained tokens → *Generate new token*.
   - Repository access: the repos you want reviewed.
   - Permissions: **Contents: Read**, **Metadata: Read** (more are added in the reviewer step).
3. In this repo: **Settings → Secrets and variables → Actions**
   - Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GEMINI_API_KEY`, `TARGET_REPO_TOKEN` (the PAT).
   - Variables: `DEFAULT_TARGET_REPO` = `owner/name` of the repo to index nightly.
4. **Actions → index-repo → Run workflow** (optionally enter another `owner/name`).

## 5. Try the reviewer locally (no Cloudflare account needed yet)

The reviewer reads a PR, the repo's standards (from the PR's **base** commit), linked issues, CI
results and related indexed code, then asks Gemini for structured findings. In this step it only
**returns** the review; posting it to GitHub comes with the approval flow.

1. Give your fine-grained PAT these extra read permissions on the target repos:
   **Pull requests: Read**, **Issues: Read** (and **Checks: Read** if offered; without it the review
   just skips CI context).
2. `copy worker\.dev.vars.example worker\.dev.vars` and fill it in.
3. Run it:

```powershell
npm run dev    # starts the Worker on http://localhost:8787
```

In a second terminal:

```powershell
$token = "<API_TOKEN from .dev.vars>"
Invoke-RestMethod -Method Post http://localhost:8787/api/review `
  -Headers @{ Authorization = "Bearer $token" } -ContentType "application/json" `
  -Body '{"repo":"owner/name","prNumber":42}' | ConvertTo-Json -Depth 6
```

### Optional: `.devflow.yml`

Without it, the reviewer auto-discovers `CODING_STANDARDS.md`, `CONTRIBUTING.md`, `CLAUDE.md`,
`AGENTS.md`, `.github/copilot-instructions.md` and the `tdd` / `improve-codebase-architecture`
skills under `.claude/skills` or `.agents/skills`. Add the file to a repo's root to choose exactly:

```yaml
standards:
  - CODING_STANDARDS.md
  - path: docs/agents/frontend-style.md
    applies_to: ["frontend/**"]     # only when the PR touches these paths
skills: [tdd, improve-codebase-architecture]
ignore: ["research/**"]             # changed files the reviewer skips
```

## 6. Automated reviews: webhook → review → email → approve

Once deployed, every PR that opens or gets new commits is reviewed in the background. You get an
email with the summary and links. **Nothing is posted to GitHub until you click a link and press
Approve** on the page it opens (opening the link alone changes nothing).

### 6.1 Resend (email)

1. Sign up at <https://resend.com> with the address you want reviews sent to.
2. **API Keys → Create API key** (Sending access). This is `RESEND_API_KEY`.

Without a verified domain, Resend only delivers to your own signup address, from
`onboarding@resend.dev`. That's enough for personal use. To email others, verify a domain and set
`EMAIL_FROM` (e.g. `DevFlow <devflow@yourdomain.com>`).

### 6.2 GitHub token with write access

The PAT needs to post reviews once you approve them. Edit it (or create one for the Worker) with,
on the reviewed repos: **Contents: Read**, **Metadata: Read**, **Pull requests: Read and write**,
**Issues: Read and write**, and **Checks: Read** if offered.

### 6.3 Cloudflare Worker

```powershell
cd worker
npx wrangler login                                  # opens the browser once
npx wrangler queues create devflow-reviews
npx wrangler deploy                                 # prints https://devflow-ai.<you>.workers.dev
```

Then set the secrets. Each command prompts for the value, so it never lands in your shell history:

```powershell
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put API_TOKEN              # long random string
npx wrangler secret put GITHUB_WEBHOOK_SECRET  # long random string; you'll paste it into GitHub too
npx wrangler secret put APPROVAL_SECRET        # long random string (32+ chars); signs email links
npx wrangler secret put PUBLIC_URL             # the workers.dev URL printed by deploy
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put EMAIL_TO               # your email (comma-separate several)
```

Generate random strings with `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`.
Check it's up: open `https://devflow-ai.<you>.workers.dev/health`, which should show `{"ok": true}`.

### 6.4 GitHub webhook (per repo to review)

Repo → **Settings → Webhooks → Add webhook**:

- Payload URL: `https://devflow-ai.<you>.workers.dev/webhooks/github`
- Content type: `application/json`
- Secret: the same value as `GITHUB_WEBHOOK_SECRET`
- Events: **Let me select individual events** → only **Pull requests**

GitHub sends a ping; the webhook should show a green tick. Open a PR (or push to one) and the
email arrives once the review finishes, usually within a minute or two.

### Tuning

| Setting (`wrangler.toml` `[vars]`) | Default | Notes |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.8-flash` | Google retires models; check AI Studio if you get a 404 |
| `GEMINI_FALLBACK_MODELS` | `gemini-3.7-flash,gemini-flash-lite-latest` | Tried in order when the main model is overloaded |
| `GEMINI_THINKING_LEVEL` | `low` | `low` took 15–70s per review in testing and caught 5 of 6 planted issues; `default` took 4–5 minutes |

## 7. Chat with the agent (API)

The agent answers questions about the repo: it searches code, reads files, PRs and issues, looks
at the import graph, and can run a review. It **cannot post anything**: "comment on #12" becomes a
pending action you approve (`GET /api/actions`, then `POST /api/actions/<id>/approve`). The web UI
(next step) wraps this.

```powershell
$token = "<API_TOKEN>"
$body = @{ repo = "owner/name"; messages = @(@{ role = "user"; text = "Which files import src/geo.ts?" }) } | ConvertTo-Json -Depth 4
Invoke-RestMethod -Method Post https://devflow-ai.<you>.workers.dev/api/chat `
  -Headers @{ Authorization = "Bearer $token" } -ContentType "application/json" -Body $body
```

Chat uses `GEMINI_AGENT_MODEL` (Flash-Lite by default): in testing it answered a multi-tool
question in 11s where 3.8 Flash took over 4 minutes. Reviews keep using `GEMINI_MODEL`.

> **Free-plan limit:** a Worker request may make at most 50 outgoing calls. A chat that also runs
> `review_pull_request` on a big PR can approach that; if you see "Too many subrequests", ask for
> the review separately.
