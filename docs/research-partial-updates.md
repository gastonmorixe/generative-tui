# Research: partial updates and skeleton-first generation

*2026-11-20. Research only. No code was changed. Status of each claim:*
**[verified]** = I read it in this repo or in the cited doc.
**[unverified]** = an inference or second-hand information. Measure it before you depend on it.

## Summary

- **Yes, partial updates fit the budget.** Use **section-level upserts keyed by
  model-chosen slug ids**, plus a **full ordered `layout` list** each turn. The
  model re-sends the skeleton (ids, titles, widths, tones) and the actions every
  time. It sends `blocks` only for the sections that changed. Removal = leave the
  id out of `layout`. Move = reorder `layout`. A full screen is the same schema
  with every section filled, so the fallback needs no second schema.
- **Do not use RFC 6902 paths or array indexes.** Every serious prior-art
  protocol uses a **flat map keyed by stable ids** (A2UI, json-render) or replaces
  by id (LangGraph). JSON Patch is used where a *program* writes the delta (AG-UI
  STATE_DELTA). json-render has the LLM write RFC 6902 ops, but only onto a flat
  `/elements/<id>` map, never onto deep indexes.
- **Budget math** (recommended schema): UiTurn 4 + LayoutItem 4 + Fill 2 + Block
  30 + Action 2 = **42**. With the 2 slim tool props that is **44**: the measured
  pass point, over the internal `PROPERTY_BUDGET = 42`. Drop `Progress.tone` and
  `BarChart.unit` (the renderer derives them) to get back to **42 total**.
- **The skeleton is nearly free in one stream**: put `layout` before `fills` in the
  schema. The partial parser already paints while it streams. The app paints
  titled empty boxes (shimmer) for new ids and keeps the old content for kept ids.
  This relies on the provider emitting keys in schema order **[unverified for
  Anthropic]**.
- **Current state goes to the model as a compact digest** (ids, titles, block types
  and sizes: about 100-200 tokens) prepended to each user turn. Without it, the
  model must replay a chain of deltas from history.
- **Repair is local, not global**: validate each fill on its own with zod, keep the
  previous section on failure, and request a full screen only when more than half
  of the ops fail or the state is empty.
- **Parallel fan-out per slot** (skeleton call, then N section calls) removes the
  budget problem (each call has a small schema) and isolates slow tool slots. It
  costs N x input tokens, risks coherence between slots, and needs session forking
  in core **[unverified]**. It is phase 2, not phase 1.
- **Expected win** on follow-up 'edit' turns (add a row, change one chart): about
  50-80% fewer output tokens and a lower time-to-final **[unverified estimate:
  the mock screen is about 3 KB of JSON, and a one-section edit is about
  300-600 B]**. On new-topic turns there is no win (the model fills all sections),
  and the cost is about +10% for the layout list.

## Current baseline

**[verified, from src/ and docs/]**

- `Screen{title, sections[{title,tone,width,blocks[Block]}], actions[{label,prompt}]}`.
  Block = 9-variant discriminated union. Property count: Block variants 30
  (text 3, list 2, keyValue 2+2, table 3, progress 4, badges 2+2, code 2,
  sparkline 3, barChart 3+2), Section 4, Action 2, Screen 3 = **39**. Plus
  WebSearch.query + Fetch.url = **41 / 42**.
- `agent.ts` `streamTurn`: buffer `text_delta`, reset at each `turn_started`. Every
  30 ms or more: `parsePartialJson(extractJsonText(buf))` -> `onPartial`. At the
  end: `JSON.parse` + `Screen.safeParse`. One repair turn in the same session.
- `app.tsx` state: `view` (partial or valid) and `screen` (last valid). The
  new turn's partial **replaces** the whole view (about line 91:
  `onPartial -> setS({view: partial})`). Nothing carries over between turns
  except `screen` as the fallback on failure.
- Every turn costs a full screen of output tokens. History grows by one full
  screen each turn (the session keeps the assistant JSON), so input tokens grow
  as well.
- With tools, nothing renders until the last round. The tool log is the only
  feedback during searches.
- Core already parses Anthropic `input_json_delta` into `tool_use_input_delta`
  (`plugin-api/src/llm/anthropic-stream.ts:217`) and assembles it
  (`src/llm/codec/stream-assembler.ts:454`). **[unverified]**: whether `session.run`
  surfaces tool-input deltas as public events (only `text_delta` was seen in
  `src/sdk/send-attempt.ts:164`). This matters for the 'tools-as-mutations' option.

## Approaches for partial updates

| Approach | Shape of a turn | Output tokens (edit turn) | LLM reliability | Validation | Schema budget | State the model must know |
| --- | --- | --- | --- | --- | --- | --- |
| **A. Full screen (today)** | whole Screen | 100% | high: no ids | one zod pass | 39 | none (regenerates) |
| **B. RFC 6902 JSON Patch** | `[{op,path,value,from}]` | lowest | **low**: `/sections/2/blocks/1/rows/3` index math, and indexes shift after earlier ops | per op, but `value` is untyped | `value` must be any (no grammar), or one union per path (explodes) | exact array layout |
| **C. RFC 7396 Merge Patch** | partial Screen object | low | medium | hard: arrays replace whole, null = delete conflicts with nullable fields | cannot express 'partial' with all-required strict keys | full structure |
| **D. Id-keyed section upsert + layout list (recommended)** | `layout[ids]` + `fills[{id,blocks}]` | low (layout about 15 tok/section + changed sections) | **high**: semantic slug ids, no indexes, idempotent | zod per fill; layout checks are trivial | about 42 (see below) | id list + titles (digest) |
| **E. Op log (upsert/remove/move ops)** | `ops[{op,id,after,section}]` | low | medium: `after` anchors fail on reorders, ordering bugs | per op | about 7 props/op + Block = 44+ with tools | id list and order |
| **F. Tools as UI mutations** (`set_section`, `remove_section`, `set_actions`) | tool calls, empty final text | low | high per call (strict tool input) | per call | each tool input counts: set_section about 5 + Block 30 = 35, set_actions about 3 -> 38 + 2 web = 40, only **if outputSchema is dropped** | id list |
| **G. Client-side diff (model gives full, app diffs)** | full Screen | 100% | high | one pass | 39 | none |
| **H. Prompt-only JSONL ops (no structured output)** | one JSON op per line | low | medium: no grammar, but each line fails alone | per line | **0** (no grammar) | ids |

Notes:

- **G** saves nothing on tokens. It only gives stable React keys, so unchanged
  sections do not flicker. This is useful as a cheap add-on to A *today*: key
  sections by title or by index.
- **F** costs a model round: after the tool calls, core sends the tool results
  back and the model answers again (one extra round of input tokens and
  latency), unless the loop can stop right after the mutation calls
  **[unverified whether core can end a turn on a tool call]**. It also
  conflicts with the 'only the last response text is the screen' design and with
  WebSearch rounds. Good fit only if the project drops `outputSchema`.
- **H** is what A2UI v0.9 ('prompt-first') and json-render (SpecStream) do. The
  budget disappears, and per-line validation plus repair takes over. It is the
  best escape hatch if the catalog must grow beyond about 42 props.
- **B, the reliability problem**: a model must count array positions in a
  document it saw several turns ago. Every insert shifts later indexes. Id
  keys make ops idempotent and order-free. I found no published error-rate
  measurement for LLM-written JSON Pointer paths **[unverified; measure it if B
  is considered]**.

## Skeleton / incremental generation

### What we have

One stream, progressive: the title paints first, then section 1's title, tone, and
blocks, and so on. Time-to-first-useful-paint is about the latency of the first
50 or so tokens. However, (1) the actions arrive last, (2) the user does not know how
many sections are coming, and (3) with tools nothing paints until searching ends.

### Options

1. **Skeleton-first field order in one stream (cheap, recommended).** The schema
   order is `title, layout[{id,title,width,tone}], fills[{id,blocks}], actions`. The
   partial parser gives `layout` first, so the app draws every box with its title and
   border at the final size (`packRows` can lay out half/third pairs
   immediately), with a shimmer or '...' body. The fills then stream into their boxes.
   On edit turns, kept sections show their old content right away (dimmed until
   the layout confirms them). Cost: about 10-15 tokens per section. **Risk**: the
   provider must emit object keys in schema order. OpenAI strict documents
   this; Anthropic constrained decoding *likely* follows the schema order
   **[unverified: check the raw text of one turn]**.
2. **Moving `actions` before `fills`.** This gives clickable follow-ups early, but
   the model must commit to follow-ups before it writes the content (lower
   quality). Keep the actions last.
3. **Parallel fan-out per slot.** Call 1: skeleton schema (UiTurn without
   fills, about 10 props). Calls 2..N in parallel: one Section schema each (about 34
   props, no tools unless the slot needs them). Pros: total latency = skeleton +
   max(slot) instead of the sum; each call is far below the budget; a slow
   web-search slot does not block others; a failure is per slot. Cons: N x the
   system prompt + context input tokens (prompt caching helps: same prefix); slots
   can contradict each other or repeat content; each slot needs a session that
   sees the conversation (core session forking **[unverified]**, else a digest in
   the prompt); more API calls and rate limits. Worth it for 'research'
   screens with 4+ slow sections, not for chat-like edits.
4. **Lazy slots**: the skeleton marks some sections 'load on focus', and the app
   fills them only when the user selects them. This does not fit a one-screen TUI
   well. Skip it.
5. **Tools + skeleton**: today a tool turn paints nothing until the last round.
   Two options: (a) parse a layout-only preamble from the tool-calling round
   (fragile: no schema on that round); (b) fan-out (option 3) where only the slots
   that need it get WebSearch/Fetch. **Recommendation**: keep tools in the
   single-stream design for now, and show the *previous* screen dimmed + the tool
   log while tools run (the old content stays useful).

## Prior art

| System | Update model | Ids / paths | Skeleton / progressive | Link |
| --- | --- | --- | --- | --- |
| **Vercel AI SDK** streamObject / partialObjectStream; v6: streamText + Output.object / Output.array (partialOutputStream, elementStream) | full object, partial snapshots while streaming; elementStream yields complete array elements | none (positional) | progressive partial object (same as ours) | https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data , https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0 (streamObject deprecated in 6.0) |
| **AI SDK RSC streamUI** | the model calls tools, and each tool returns a React component (a generator yield = loading UI) | tool-call id | yes: yield a spinner, then return the final component. Experimental; the docs recommend moving to AI SDK UI | https://ai-sdk.dev/v5/docs/ai-sdk-rsc/migrating-to-ui |
| **json-render (vercel-labs)** | **SpecStream**: JSONL, each line an RFC 6902 op on a flat spec {root, elements:{id:{type,props,children:[ids]}}}. Has an **Ink renderer** (@json-render/ink) | element keys (/elements/metric-1), children by id | progressive: elements appear as lines arrive; catalog goes in the prompt (no structured output) | https://json-render.dev/docs/streaming , https://github.com/vercel-labs/json-render |
| **Google A2UI** v0.8 / v0.9.1 / v1.0 | messages createSurface, updateComponents (flat list of components, upsert by id, adjacency list via child ids, root id 'root'), updateDataModel (JSON Pointer path + value, omitted value = delete), deleteSurface | component id; data by JSON Pointer; structure and data kept separate | yes: components may reference children that do not exist yet, and clients render placeholders. v0.9 moved from structured output to **prompt-first** because structured-output limits constrained the catalog | https://a2ui.org/specification/v0.9.1-a2ui/ , https://a2ui.org/specification/v0.8-a2ui/ |
| **AG-UI (CopilotKit)** | STATE_SNAPSHOT (replace) + STATE_DELTA (RFC 6902 array, applied in sequence with fast-json-patch); on inconsistency the client asks for a fresh snapshot | JSON Pointer | the state streams; the UI is the app's own components | https://docs.ag-ui.com/concepts/state |
| **LangGraph generative UI** | push_ui_message(name, props, id): the same id **replaces**, metadata.merge = true shallow-merges props; delete_ui_message(id) | message id | component-level streaming of props | https://docs.langchain.com/langsmith/generative-ui-react , https://www.assistant-ui.com/docs/runtimes/langgraph/generative-ui |
| **OpenAI Apps SDK / MCP Apps** | the tool returns structuredContent (full props of a widget); the widget keeps widgetState and can call tools itself | tool call / widget instance | no model-level deltas: the developer-written widget renders the data **[partly verified via the examples repo]** | https://github.com/openai/openai-apps-sdk-examples , https://developers.openai.com/plugins/reference |
| **Thesys C1** | an OpenAI-compatible API that streams its own UI spec, rendered by the Thesys React SDK | **[unverified internals]** | streaming render | https://docs.thesys.dev/guides/what-is-thesys-c1 |
| **Anthropic Artifacts** | the model edits an artifact by string replacement (update old_str -> new_str) or by a full rewrite | text anchors, not paths | streaming text **[unverified; known only from public system-prompt dumps]** | - |
| **Grammar-size limit** | Anthropic rejects big schemas with 'compiled grammar is too large'; others report about 42 properties; TanStack AI notes there is no fallback | - | - | https://github.com/anthropics/anthropic-sdk-python/issues/1185 , https://github.com/TanStack/ai/issues/682 , https://dev.to/robswierk/anthropics-grammar-compiler-counts-properties-not-characters-5el6 |

**What they agree on**: (1) flat, id-keyed maps for the UI structure; (2) snapshot
+ delta with a snapshot fallback; (3) LLM-facing protocols that outgrow
structured-output limits move to prompt-first plus validation (A2UI v0.9,
json-render); (4) placeholders for referenced but not yet sent ids.

## Recommendation

### Design 1 (recommended): 'layout + fills' delta screen, structured output kept

```ts
// src/schema.ts sketch: the Block union is unchanged (30 props)
const LayoutItem = z.strictObject({
  id: z.string().describe('Stable slug, e.g. prices. Reuse it to keep or edit a section'),
  title: z.string().nullable(),
  width: SectionWidth,
  tone: Tone,
})                                                     // 4 props
const Fill = z.strictObject({
  id: z.string(),
  blocks: z.array(Block),
})                                                     // 2 props
export const UiTurn = z.strictObject({
  title: z.string().nullable().describe('null = keep the current title'),
  layout: z.array(LayoutItem).describe('ALL sections in order. An id missing here is removed'),
  fills: z.array(Fill).describe('Content only for new or changed ids. Kept ids keep their blocks'),
  actions: z.array(Action),
})                                                     // 4 props
```

| Part | Props |
| --- | --- |
| UiTurn (title, layout, fills, actions) | 4 |
| LayoutItem (id, title, width, tone) | 4 |
| Fill (id, blocks) | 2 |
| Block (9 variants, unchanged) | 30 |
| Action (label, prompt) | 2 |
| **Schema total** | **42** |
| + WebSearch.query + Fetch.url | **44** |

44 = the measured pass point, but over PROPERTY_BUDGET = 42 (0 headroom,
not safe). **To fit 42**: remove Progress.tone (derive it: <30 error, <70
warning, else success) and BarChart.unit (put the unit in the bar labels or
the section title) -> schema 40 + tools 2 = **42**. Do not save props with
`fills: Block[][]` aligned by position: that is index math again.

Why section granularity: a section is the unit that users ask to change ('add a
row to the table' re-sends one section). Block-level ids would need one more
object with an id per block (+1-2 props), and the model would have to manage twice as
many ids.

**Apply semantics (deterministic, in a new src/screen-state.ts)**:

```
state: { title, order: id[], sections: Map<id,{title,width,tone,blocks}>, actions }
apply(turn):
  title    = turn.title ?? state.title
  for item in layout: meta from item; blocks = fill[id]?.blocks ?? state.sections[id]?.blocks
  sections not in layout -> dropped (removal)
  fill id not in layout -> append at end (repair, log warning)
  layout id with no fill and no prior blocks -> placeholder '(no content)' + warning
  duplicate ids -> last wins, warning
  actions  = turn.actions (always full; 2-6)
```

### Changes to the code

- **schema.ts**: add UiTurn, LayoutItem, Fill. Keep Screen as the *rendered*
  type (the app keeps rendering a Screen). Update the budget tests.
- **agent.ts**: `outputSchema: wireSchema(UiTurn)`. Keep a ScreenState in the
  agent. `onPartial` gets `applyPartial(state, partialTurn)`. This is the same apply
  function, tolerant: a layout item without an id is skipped; a fill without blocks yet
  keeps the old blocks or shows a shimmer. Final: UiTurn.safeParse. Report issue paths
  as `fills.<id>.blocks.n`, not by index. **Per-op repair**: a failed fill
  keeps the old blocks. Only failed ids go into the repair prompt ('re-send fills for
  ids X, Y'). A repair turn is the same schema, so it merges.
- **Prompt with state**: before each user message, add a digest:
  ```
  [current screen] title: Coffee prices
  - prices  | half | info   | Prices  | table 4x6
  - trend   | half | normal | Trend   | sparkline 30
  - sources | full | muted  | Sources | list 3
  ```
  About 15 tokens per section. The system prompt says: keep ids; re-send fills only
  for sections that change; leave unchanged ids out of fills; to start a new topic,
  use new ids and fill all of them. The full JSON of a section is already in the
  history (an earlier fill). Optionally, include the full current JSON every K turns or
  after a compaction **[design choice; untested]**.
- **app.tsx**: the state holds a ScreenState (rendered as a Screen). The new turn
  starts from the *previous* state (not empty): kept sections stay visible, new ids
  paint as shimmer boxes, and removed ids disappear when the layout is complete
  (to avoid flicker, apply removal only when `fills` starts or at the end). Use
  React key={id} for sections.
- **Fallback to a full screen**: if the state is empty, or if more than 50% of the
  layout ids fail validation, or if the model fills 0 sections on a new-topic turn,
  send a repair: 'Answer with every section filled.' The same schema, so no second
  request shape.
- **Mock transport**: emit a UiTurn (first turn: all filled; later turns: one
  fill) so that the PTY tests cover the merge.

### Design 2 (alternative, if the catalog must grow): prompt-only JSONL ops

Drop outputSchema. Each line is one op: layout, fill (id + blocks), actions, or
title. Parse line by line (each line is small, so the partial parser is still
useful for the open line). zod validates each line, and invalid lines are dropped
and listed in the repair turn. Budget: 0, so the catalog can grow (cards, columns,
inputs come back). Cost: no grammar guarantee. Expect more invalid lines on small
models **[measure: invalid line rate]**. Same model as json-render SpecStream and
A2UI v0.9. The apply/state code from Design 1 is reused unchanged. Only the parser
and validation change.

## Experiment plan

**Setup**: claude-haiku-5-5. Arms: baseline (Screen) vs Design 1
(UiTurn, budget-trimmed). Optional third arm: Design 2. Tools on and off. Each
arm runs the same scripted 6-turn sessions x 3 topics x 3 repetitions:

1. 'Compare the 3 most used JS runtimes' (new topic, all fill)
2. 'Add a row for Deno 3' (one-section edit)
3. 'Show the startup time as a bar chart instead' (block-type change)
4. 'Remove the sources' (removal only)
5. 'Put the chart first' (reorder only)
6. 'Now do the same for Python package managers' (new topic)

**Metrics** (log per turn to a JSONL file: the provider usage from the core run
result **[unverified field name]**, plus timestamps of onPartial):

| Metric | Definition | Success criterion (Design 1 vs baseline) |
| --- | --- | --- |
| Output tokens / turn | provider usage | turns 2-5: **at least 50% lower**. Turns 1, 6: at most +15% |
| Input tokens / turn | provider usage | turn 6: at or below baseline (history grows more slowly) |
| TTFP | time from send to first paint with at least 1 new or kept section with a title | at or below baseline on all turns; edit turns: old content visible at t=0 |
| Time to final | send -> valid apply | turns 2-5: at least 30% lower |
| Op error rate | (unknown fill ids + layout ids without content + failed fills) / total ops | **< 5%**, 0 lost sections |
| Preservation | kept sections byte-identical to the previous state, when the user did not ask to change them | at least 95% |
| Intent accuracy | manual check: did turn 2 change only the table, did turn 4 remove only Sources, and so on | at least 90% |
| Repair rate | turns that needed a repair | at or below baseline |
| Budget canary | real request with UiTurn + tools: 40 + 2 must pass; also try 44 untrimmed | 42 passes; record 44 |

**Bonus measurements**: (a) do Anthropic outputs follow the schema key order (is
layout emitted before fills)? Check the raw text of 10 turns. (b) bisect 45-47
props to learn the real budget (open question in findings.md).

**Stop rule**: if the op error rate is > 10% or intent accuracy is < 80% after
one round of prompt tuning, keep the baseline plus client-side stable keys
(approach G) and close the experiment.

## Open risks

- **Budget**: Design 1 untrimmed is 44 with tools, which is exactly the measured
  pass and not safe. Trimming two fields changes the UX slightly. Other providers'
  limits are unknown.
- **Key order**: if Anthropic does not emit keys in schema order, the skeleton-first
  paint has no effect **[unverified]**. The fallback is Design 2, where the line order is
  explicit.
- **Model laziness / over-editing**: a model might re-fill every section (no
  savings), or skip a fill that it should have changed (stale content). The
  preservation and intent metrics catch both. The digest wording matters.
- **Id drift**: the model renames prices -> price-table, which removes and
  re-adds the section (it costs tokens and loses nothing, but the box flickers).
  Mitigation: the digest lists the exact ids. Optionally, fuzzy-match a new id to a
  removed id with the same title.
- **History versus digest disagreement** after a repair or a compaction: the digest
  is the source of truth. Always build it from the app state, not from the history.
- **Tool turns** still paint nothing new until the last round. Design 1 only makes
  this less painful (the old screen stays). The real fix is fan-out (phase 2).
- **Fan-out** needs session forking or context copies in core **[unverified]** and
  multiplies the input cost. Not part of the first experiment.
- **Not verified here**: the internals of Thesys C1, OpenAI Apps SDK widgets, and
  Anthropic Artifacts; whether session.run exposes tool-input deltas; core usage
  fields; the exact token savings (estimates only).
