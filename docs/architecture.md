# DevFlow AI — Architecture

## Context
An autonomous developer assistant for the user's own repositories, meant for real use rather than a demo. It reviews PRs against linked requirements, answers questions about the code, and proposes GitHub updates only after the user approves.

Constraints and decisions:
- Every service runs on a free tier, the code is TypeScript, and no LLM runs locally (the development machine has 4GB RAM).
- First targets are TS/JS and Python repos.
- The user has no accounts yet, so a setup guide is part of the work.

Decisions made in discussion:
- **No Make.com/n8n.** n8n is only free when self-hosted. The Worker receives webhooks directly and sends email through Resend.
- **GitHub Issues replaces Jira** as the source of requirements. Issues are linked from the PR body ("Fixes #12", "#12") and from GraphQL `closingIssuesReferences`. Approved write-backs can comment on the issue and add labels.

Already created before the pause, and kept:
- npm workspaces (`worker`, `indexer`), `tsconfig.base.json`, `vitest.config.ts`.
- `shared/gemini.ts` and `shared/supabase.ts`.
- TypeScript is pinned to 5.9 because TS 7 has no compiler JS API.

## Architecture
- **Cloudflare Worker** (`worker/src`):
  - `POST /webhooks/github`: verifies the HMAC signature. On `pull_request` opened/synchronize/reopened, it enqueues a review job and returns 202.
  - **Queue consumer:** runs the review, stores the result, creates pending actions, and emails a summary through Resend.
  - **Approvals:** `GET /actions/:id?sig=` shows a confirmation page, and `POST` executes the action. The GET only displays the page, so email link scanners can't trigger an action.
  - **Authenticated API** (bearer token): `/api/chat`, `/api/review`, `/api/actions`.
  - `GET /` serves the web UI (chat plus approvals panel), loaded from `ui.html` as a text module.
- **GitHub Actions** (`.github/workflows/index-repo.yml` + `indexer/src`):
  - Triggered by `workflow_dispatch`, `repository_dispatch`, or a nightly run.
  - Chunking: the TS compiler AST for TS/JS (functions, classes, methods, types). Python is split by indentation (def/class plus decorators).
  - Markdown is split by heading; other files by line windows.
  - Re-runs are incremental by file hash. Stale chunks are deleted.
  - Builds an import graph (resolved internal paths plus external packages).
- **Supabase** (`supabase/schema.sql`):
  - Tables: `code_chunks` (vector(768) + generated tsvector that splits camelCase), `code_files`, `repositories`, `reviews`, `pending_actions`.
  - `hybrid_search` RPC: combines vector and full-text results with Reciprocal Rank Fusion (RRF).
  - RLS is enabled; the service key is used server-side only.
- **Gemini:**
  - Flash model (configurable var) for the review, using a JSON-schema response, and for the agent, using function calling.
  - Embeddings: `gemini-embedding-001` at 768 dimensions, normalised.
  - Retries on 429 errors.

## Reviewer (`worker/src/review`)
1. Fetch PR metadata, the list of changed files, and the linked issues.
2. Number every diff line with its line number in the new file, and record which lines GitHub will accept inline comments on.
3. Retrieve related code with hybrid search over the changed snippets.
4. Ask Gemini for a structured result:
   - Top level: summary, verdict, and requirement compliance against the linked issues.
   - Each finding: severity, category, file, line, title, description, and suggested fix.
5. Check every finding's line. Valid ones become inline review comments; the rest go into the review body.
6. Create pending actions (a GitHub review, plus optionally an issue comment/labels) and email the summary with signed links.
7. Cache results by head commit SHA.

## Standards-aware review (modeled on Wave-Propagation-Simulator)
Reference files: `C:\Workspace\Wave-Propagation-Simulator\CODING_STANDARDS.md`, `CLAUDE.md`, `.claude/skills/tdd/` (`SKILL.md`, `tests.md`, `mocking.md`, `deep-modules.md`, `interface-design.md`, `refactoring.md`).
- **Discovery** (`worker/src/review/standards.ts`):
  - Read from the PR's **base** commit, so a PR can't weaken its own rules.
  - Auto-discovered files: `CODING_STANDARDS.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`.
  - Auto-discovered skills (from `.claude/skills` or `.agents/skills`, with their reference files): `tdd` and `improve-codebase-architecture`.
  - Process skills are skipped (`grill-me`, `triage`, `caveman`, ...).
  - The total size of the standards text is capped.
- **Optional `.devflow.yml`** at the repo root: an explicit `standards` list (with `applies_to` globs), `skills`, and `ignore` globs. When present, it replaces auto-discovery.
- **Prompt and schema changes:**
  - Each finding gets an optional `rule` field: a citation of source file and section (e.g. "CODING_STANDARDS.md › Mock at system boundaries only").
  - New categories: `standards` and `testing`.
  - Respect the repo's "not a review topic" rules (formatting, anything tools enforce).
- **TDD checks:**
  - Behaviour change without tests.
  - Mocking internal modules, or asserting on internal calls.
  - Tests that verify implementation details or go through a side door.
  - Test names that describe "how" instead of "what".
  - Commit order in the PR is only a soft signal; red-first can't be proven from a diff.
- **CI context:** the PR's check-run statuses are passed in, so the reviewer doesn't repeat lint/type/format findings.

## How DevFlow itself is built
- Add `CODING_STANDARDS.md` to this repo, adapted from Wave's: deep modules, no `any`, mock only at system boundaries, config read at startup, `noUncheckedIndexedAccess`.
  - Keep npm here, not pnpm: npm is already set up and works.
- **TDD with vertical slices** (the `tdd` skill) for logic modules:
  - diff annotation, chunker, import resolution, standards discovery and `.devflow.yml` parsing, issue linking, signatures, the agent loop (with a faked Gemini).
  - Gemini, GitHub, Supabase and Resend are faked only at the network boundary.
- `npm run check` = typecheck + tests, the same as CI. A GitHub Actions `check.yml` runs it on push and PR.
- Retrofit `shared/gemini.ts` and `shared/supabase.ts` to the standards: inject `fetch` and read config at startup.

## Agent (`worker/src/agent`)
- A Gemini function-calling loop, capped at about 8 steps.
- Read-only tools: `search_code`, `read_file`, `list_pull_requests`, `get_pull_request`, `get_issue`, `search_issues`, `analyze_dependencies`, `review_pull_request`.
- Write tools only create pending actions: `propose_pr_comment`, `propose_issue_update`.
- Chat history is kept in the browser.

## Build order (each step verifiable)
1. Write the setup guide for the accounts (Gemini key, Supabase, Cloudflare, Resend, GitHub fine-grained PAT plus webhook secret), and apply the schema.
2. Indexer plus hybrid search. Run it on one of the user's repos and check the search quality.
3. Reviewer through `/api/review` (including standards discovery), run manually on a real PR. Use a Wave-Propagation-Simulator PR as the first standards test.
4. Approvals, Resend email, webhook, and Queue (end-to-end automation).
5. The agent and the `/api/chat` endpoint.
6. The web UI.

## Verification
- **Unit tests (vitest):** diff annotation and commentable lines, chunker (TS/Python), import resolution, issue-reference extraction, HMAC signing and webhook verification.
- **Static checks:** `npm run typecheck`, `wrangler dev` locally.
- **End to end:** open a test PR that links an issue → an email arrives → approve → the review comments appear on the PR → a chat question gets answered with `path:line` citations.
