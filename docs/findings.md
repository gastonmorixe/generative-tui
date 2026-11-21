# Findings

What the experiment measured and learned. Each finding has a date and the
model it was measured on, where that matters.

## 1. Anthropic limits schema properties, not bytes

*claude-haiku-5-5, 2026-11-19.* Anthropic returns HTTP 400 "The compiled
grammar is too large". 44 object properties pass, and 48 fail. Reuse through
`$ref`/`$defs` does not help: an 11.9 KB schema that used `$defs` still
failed. The first catalog had 57 properties, plus cards and columns. The fix
was a flat layout (sections with a `width`) and fewer tone fields. Details are
in [schema.md](schema.md#property-budget). Other providers were not measured.

## 2. A provider error is not a model error

After a 400, a repair turn sends the same request again. `ask()` repairs only
a **completed** turn whose output fails zod. See [streaming.md](streaming.md).

## 3. Half-written discriminators

`"type":"keyVa"` would show as an unknown block. The renderer treats a prefix
of a known type as pending.

## 4. The core API was sufficient

`outputSchema` on `openSession`, deltas from `session.run`, and `bootHost` +
`resolveAuth` were enough. No change to core was needed. Core does not export
`TransportFn`, so the code derives it from `SessionOptions["sendFn"]`.

## 5. Tools use the same grammar budget

*claude-haiku-5-5, 2026-11-19.* With WebSearch + Fetch in the request, the
same Screen failed again, for two reasons:

- (a) The full tool input schemas have 9 + 10 properties. The fix:
  `SLIM_FIELDS` sends only `query` and `url`.
- (b) `reused: "ref"` put each union variant into its own `$defs` entry.
  14 defs + 2 tools fail, and 2 defs (`Block`, `Tone`) + 2 tools pass. The
  fix: only `.meta({ id })` schemas go to `$defs`.

See [tools.md](tools.md).

## 6. Turns with several rounds

The screen is the text of the **last** response only. The buffer is reset at
each `turn_started`.

## 7. Ink input race

A key pressed just after a frame was drawn went to the previous handler. The
fix is a ref that a layout effect updates (210 of 210 reruns passed). See
[rendering.md](rendering.md#the-stale-input-handler-fixed).

## Open questions

- What is the budget on other providers (OpenAI strict, Gemini, local
  grammar engines)?
- Is the Anthropic limit really on properties, or on a measure that grows with
  them, such as grammar states? Only 44 and 48 were measured. 45–47 were not
  measured.
- Only 1 property of headroom is left. Can the limit change by model or by
  date? Add a canary test that sends a request to the live provider.
