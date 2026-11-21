# Docs changelog

## 2026-11-20 (research)

- Added `research-partial-updates.md` (written by a sub-agent): partial updates
  through section upserts keyed by id, a skeleton-first field order, prior art
  (A2UI, AG-UI, json-render, LangGraph, AI SDK), and an experiment plan.
  No code was changed. It is linked from the index.

## 2026-11-20 (later)

- **Code fix:** `extractJsonText` now cuts out exactly one JSON object. It
  finds the matching closing brace (and skips strings) and drops text after
  the JSON. It also handles fences with a language tag and `{` in prose
  before a fence. Before, text after the JSON with no fence broke
  `JSON.parse`. 7 new tests are in `test/core.test.ts`. streaming.md now has
  an `extractJsonText` section.

## 2026-11-20

- Created `docs/` with these pages: architecture, schema, streaming,
  rendering, tools, testing, findings.
- Fixed: the top-level README said `PROPERTY_BUDGET = 40`, but the code has
  `42`. The counts measured now are Screen 39 + tools 2 = 41.
- Documented an existing limit: `extractJsonText` does not cut text after the
  JSON when there is no code fence.
- Added the open questions to findings.md.
