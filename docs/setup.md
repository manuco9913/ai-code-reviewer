# Setup

All services below have a free tier that covers personal use. Accounts are added as the build
progresses; this page covers what the current step needs.

| Step | Needs |
|---|---|
| 1–2. Index + search (now) | Gemini API key, Supabase project |
| 2b. Index from GitHub Actions | This repo pushed to GitHub, a fine-grained PAT |
| 3–4. Reviewer, approvals, email | Cloudflare account, Resend account, GitHub webhook *(guide added then)* |

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
