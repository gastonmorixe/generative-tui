# Streaming, validation and repair

Sources: `src/agent.ts` (`GenerativeAgent`) and `src/partial-json.ts`.

## One `ask()`

1. `onStatus("generating…")`, then `streamTurn(prompt)`.
2. `streamTurn` reads the `session.run` entries and acts only on events:

   | Event | Action |
   | --- | --- |
   | `turn_started` | Reset `text` and `finalText`. Each model response starts one; see [tools.md](tools.md) |
   | `text_delta` | `text += delta`. At most every 30 ms: `onPartial(parsePartialJson(...))` |
   | `item_completed` (text) | `finalText = e.text`: the authoritative full text |
   | `item_started` / `tool_result` | `onTool(toolActivityOf(e))` for the tool log |
   | `error` | Keep the message and show it in the status line |

3. At the end, one last `onPartial` with the full text. This also covers the
   last delta that the throttle skipped.
4. **Outcome is not `completed`** (provider 400, network, abort) → return
   `ok: false` immediately, with no repair. A repair would send the same
   failing request again.
5. `JSON.parse` fails → repair. `Screen.safeParse` fails → repair with up to 8
   zod issues formatted as `path: message`.
6. A valid result returns `{ ok: true, screen, raw, repaired }`.

`MAX_REPAIRS = 1`. The repair turn is a normal user message in the **same
session**, so the model sees its bad answer:

```
Your last answer did not match the Screen schema. Problems:
- sections.0.blocks.1.percent: Expected number, received string
Answer again with the same content as ONE valid Screen JSON object, nothing else.
```

### `extractJsonText`

Source: `partial-json.ts`. Some models wrap the JSON in other text, even in
structured mode. This function cuts out only the JSON object. Every call
site uses it: each paint while streaming, the final paint, and validation.

1. **Start points.** The first `{` in the text, then the first `{` after
   each opening fence (```` ``` ```` or ```` ```json ````).
2. **End point.** For each start, `valueEnd` scans to the matching `}`. It
   counts `{`/`[` depth and skips string contents, escapes included. So a
   `}` or a ```` ``` ```` inside a string (for example in a `code` block)
   does not end the scan.
3. **Pick a start.**
   - The object has not closed yet (it is still streaming): return the rest
     of the text, so `parsePartialJson` gets the prefix.
   - It closed and `JSON.parse` accepts it: return exactly that object.
     Text after it is dropped.
   - It closed but is not JSON (for example `{braces}` in prose before a
     fence): try the next start.
4. If no start gives valid JSON, return the first closed one. Then the error
   from `JSON.parse` points to the real problem.

| Raw text | Result |
| --- | --- |
| `{...}` | the same text |
| `Here: {...}\nHope that helps!` | `{...}` |
| ```` ```json\n{...}\n``` ```` | `{...}` |
| ```` Use {braces}:\n```json\n{...}\n``` ```` | `{...}` (the one after the fence) |
| `prose {"title":"He` | `{"title":"He` (streaming) |
| no `{` | `""` |

Tests: `describe("extractJsonText")` in `test/core.test.ts`. One test also
checks every prefix of the mock screen.

## Partial JSON parser

`parsePartialJson(prefix)` turns any **prefix** of valid JSON into the most
complete value it can:

| Input | Output |
| --- | --- |
| `{"title":"Hel` | `{ title: "Hel" }`: an open string keeps its text (typing effect) |
| `{"title":"A","sec` | `{ title: "A" }`: a key with no value is dropped |
| `{"a":tru` | `{}`: a half literal (or a lone `-`) is dropped |
| `{"s":[{"x":1` | `{ s: [{ x: 1 }] }`: open containers close implicitly |
| `` / whitespace | `undefined` |
| `{]` | throws: no suffix can make it valid |

The agent wraps it in `safePartial`, which returns `undefined` on a throw. So
a bad chunk never breaks the UI.

### Half-written discriminators

While it streams, a block can be `{"type":"keyVa"}`. The renderer
(`BlockView` in `src/render.tsx`) checks whether `type` is a **prefix of a
known type** (`BLOCK_TYPES`). If it is, the block shows as pending, not as an
unknown block. Every block reader also accepts missing or wrong fields,
because a partial value never matches the schema.

## Cost

Each throttled paint parses the whole buffer again (O(n) for each paint). With
`maxTokens: 8192` and 30 ms throttling this is cheap. If screens grow much
larger, use an incremental parser.
