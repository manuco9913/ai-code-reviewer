# Coding standards

> Adapted from the Wave-Propagation-Simulator standards (themselves based on Matt Pocock's
> `course-video-manager` standards). DevFlow's own reviewer reads this file, so keep rules concrete
> and name the section a finding should cite.

The rules a human or an agent holds in their head while writing and reviewing code here. Where a
rule is enforced by a tool, the tool is named; everything else is checked in review.

## Enforcement

`npm run check` is the one command that decides whether code is acceptable: `typecheck` (tsc,
strict + `noUncheckedIndexedAccess`) then `test` (vitest). CI (`.github/workflows/check.yml`) runs
it on every push and PR.

- Never bypass CI. If a check is wrong, fix the check in its own commit and say why.
- Formatting is never a review topic.
- npm only (workspaces: `worker`, `indexer`; shared code in `shared/`).

## Module design

### Deep modules

Prefer deep modules: a small interface hiding a large implementation.

- One concept is one module boundary. Don't spread a single concept across several thin files.
- If a caller has to call several small functions in a specific order, or read the implementation
  to use the module correctly, the module is too shallow. Push the orchestration inside.
- Ask before adding a method or a parameter: can I hide this instead?

### Extract modules, not test hooks

Extract logic into its own module when it is a concept with its own interface. Don't split out a
helper just so a test can reach it; test it through the module that owns it.

### Design for testability

1. **Accept dependencies, don't create them.** Pass `fetch`, the clock, `sleep`, stores and API
   clients in; don't construct them inside.
2. **Return results, don't produce side effects.**
3. **Small surface area.**

### Boundaries are SDK-style ports

Every external service (Gemini, Supabase, GitHub, Resend) sits behind an interface with one method
per operation (`embed`, `replaceFileChunks`, `getPullRequest`...), not a generic `request()`.
Business logic depends on the port; the adapter that speaks HTTP is the only code that knows URLs.

## Types

### Every `any` is a leak

Write the type you mean: a named `interface` for a known shape; `unknown` then narrow for an
unknown shape (all JSON from the network is `unknown` until narrowed); a constrained generic for a
shape that varies by caller. A third-party `any` is cast once at the edge into a named type.

`noUncheckedIndexedAccess` is on: `arr[i]` is `T | undefined`. Handle the `undefined`; don't
silence it with `!`.

### Optional parameters

Scrutinise every optional parameter. Forgetting to pass one is a bug that type-checks. Prefer a
required parameter, or separate functions, over a flag that changes behaviour.

## Configuration

Read every environment variable and Worker binding **at the entry point** (`worker/src/config.ts`,
`indexer/src/config.ts`), validate it, fail fast and name the missing variable. Modules receive a
typed config object, never `env`.

## Security

- Secrets never reach the browser, logs, or LLM prompts.
- Every webhook is signature-verified before its body is trusted.
- External writes (GitHub reviews, comments, labels) only happen through an approved pending
  action. The agent and reviewer can only *propose*.
- Review standards are read from the PR's base commit, never its head.

## Testing

Tests verify **behaviour through public interfaces**, not implementation details.

**Mock at system boundaries only:** Gemini, Supabase, GitHub, Resend, time and randomness. Fake
them with in-memory implementations of the port. Never mock your own modules.

Red flags in review:

- Mocking your own modules, or asserting on call counts or order of internal calls
- Verifying through a side door instead of through the interface
- A test that breaks on a refactor with no behaviour change
- A test name that describes _how_, not _what_
- Testing a one-liner or a simple mapping, where the test just mirrors the code
- Thin delegation tests for route handlers. Test the module the route calls instead.

### TDD: vertical slices

For behaviour changes, one test at a time:

```
RED→GREEN: test1→impl1
RED→GREEN: test2→impl2
REFACTOR (only when green)
```

Run the new test and **see it fail** before writing the code. Pure scaffolding (configs, SQL
schema, HTML) has no red step; say so in the commit.
