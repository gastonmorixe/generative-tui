# Architecture

## Idea

The model never answers with prose. Each turn, it answers with exactly one JSON
object of type `Screen`. The provider's structured-output mode enforces the
schema. An Ink (React for the terminal) app draws the screen **while it
streams**. Each screen also gives 2 to 6 *actions*. An action is a follow-up
prompt that the model wrote, and the user can pick it with one key.

## Data flow of one turn

```
user prompt / picked action
        │
        ▼
GenerativeAgent.ask(prompt, callbacks)                 src/agent.ts
        │  session.run(prompt, { emitDeltas: true })
        │  session opened with outputSchema = wireSchema(Screen)
        ▼
minimal-agent core ──► provider (structured output) ──► text_delta events
        │
        │  buffer += delta            (cleared at each turn_started)
        │  every ≥30 ms: parsePartialJson(extractJsonText(buffer))
        ▼
callbacks.onPartial(partialScreen) ──► <App> re-renders     src/app.tsx
        │
        ▼  turn completed
JSON.parse ──► Screen.safeParse (zod)
        ├─ valid      → AskResult { ok: true, screen }
        ├─ invalid    → 1 repair turn that lists the zod issues (MAX_REPAIRS = 1)
        └─ not "completed" (provider/transport error, abort) → fail, no repair
```

## File map

| File | Role | Details in |
| --- | --- | --- |
| `src/main.tsx` | CLI flags (`--mock`, `--once`, `--schema`, `--list-models`, `--no-tools`), host boot, starts Ink | — |
| `src/schema.ts` | zod catalog: `Screen`, `Section`, `Block` (9 types), `Action`, `Tone`, `PROPERTY_BUDGET` | [schema.md](schema.md) |
| `src/wire-schema.ts` | zod → JSON Schema in a form that providers accept | [schema.md](schema.md) |
| `src/schema-budget.ts` | `schemaStats`: counts properties, unions, nullables | [schema.md](schema.md) |
| `src/system-prompt.ts` | Design guidance for the model (the schema goes separately) | [schema.md](schema.md) |
| `src/agent.ts` | `GenerativeAgent`: session, streaming, validation, repair | [streaming.md](streaming.md) |
| `src/partial-json.ts` | Tolerant parser for a JSON prefix | [streaming.md](streaming.md) |
| `src/render.tsx` | Block and section components, `packRows` layout | [rendering.md](rendering.md) |
| `src/app.tsx` | Shell: header, sections, action bar, prompt, status, tool log | [rendering.md](rendering.md) |
| `src/tools.ts` | WebSearch + Fetch from the booted host, allow-list, slim schemas | [tools.md](tools.md) |
| `src/mock-transport.ts` | Offline `sendFn` that streams a built-in dashboard | [testing.md](testing.md) |
| `test/pty.ts` | e2e harness: Bun PTY + `@xterm/headless` | [testing.md](testing.md) |

## Seams

- **`ScreenAgent` interface** (`src/agent.ts`): this is all the TUI needs
  (`model`, `toolNames`, `ask`, `abort`, `close`). The app tests pass a fake.
- **`sendFn`** (`TransportFn`): replaces the provider transport. The mock mode
  and the core tests use it. Core does not export `TransportFn`, so the code
  derives it as `NonNullable<SessionOptions["sendFn"]>`.
- **`BootedHost`**: gives the real credentials (`resolveAuth`) and the plugin
  tools. Without a host, only `sendFn` mode works.

## Dependency on minimal-agent core

The code uses only public core API: `createRuntime`, `openSession` with
`outputSchema`, `session.run` with `emitDeltas`, `bootHost`, and
`resolveAuth`. No change to core was needed. Core and config are git
dependencies pinned to commits (see the top-level README).
