# CLAUDE.md

Guidance for Claude Code working in this repository.

DevFlow AI: a free-tier AI code reviewer and repo agent. Cloudflare Worker (`worker/`), GitHub
Actions indexer (`indexer/`), shared clients (`shared/`), Supabase pgvector (`supabase/schema.sql`).
The approved design is in `docs/architecture.md`; account setup is in `docs/setup.md`.

## Code quality

Follow `CODING_STANDARDS.md`. `npm run check` runs typecheck and tests, the same as CI.
Build behaviour test-first with the `tdd` skill (vertical slices, see a test fail before the code).
