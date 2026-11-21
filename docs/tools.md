# Web tools

Source: `src/tools.ts`. The tools are on by default when a host is booted.
Use `--no-tools` to turn them off. In `--mock` mode there are no tools.

## What the model gets

`WebSearch` (ma-web-search-plugin) and `Fetch` (ma-fetch-plugin), taken from
the booted host's tool registry. The host also registers Bash, Edit, and
other tools. Three layers make sure that only the web tools run:

1. **Registry view**: `slimRegistry.list()` returns only the allowed names.
2. **Filter**: `toolFilterFromNamePolicy({ kind: "allow-list", tools: names })`.
3. **Executor guard**: if a call names any other tool, the result is
   `Tool X is not available.` with `isError: true`, and nothing runs.

`webTools()` throws when the host registers neither tool, for example when the
plugins did not load. `bootProviders()` (in `agent.ts`) sets
`MINIMAL_AGENT_BIN_DIR`. Without it, ma-fetch cannot find `obscura`, and it
hides Fetch.

## Slim schemas

The full input schemas have 9 properties (WebSearch) and 10 (Fetch). With the
Screen, that is over the grammar budget (see [schema.md](schema.md#property-budget)).
`slimTool()` keeps only the fields in `SLIM_FIELDS`:

| Tool | Fields on the wire |
| --- | --- |
| WebSearch | `query` |
| Fetch | `url` |

The plugin gives a default to each field that is not sent. As a result, the
model cannot set options such as the result count or the format.

## Turns with several rounds

With tools, one `session.run` can hold several model responses:

```
turn_started → "Let me search…" + tool_use(WebSearch)
turn_started → tool_use(Fetch)
turn_started → { Screen JSON }        ← only this response is the screen
```

The text buffer is reset at each `turn_started`. So the text before a tool
call never reaches the parser. `toolActivityOf()` maps `item_started`
(tool_use) and `tool_result` events to `ToolActivity` items, and the app
shows them as a live log.

A real run (2026-11-19) made 3 searches and 2 fetches, and then returned a
valid screen with a "Sources" section. The system prompt asks for that
section.
