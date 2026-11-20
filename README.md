# Generative TUI experiment (2026-11-19)

The model answers every turn with one JSON `Screen` instead of prose, and an
Ink TUI renders it while it streams. Stack: minimal-agent core
(`createRuntime` → `openSession` with `outputSchema`), zod 4 (catalog and
validation), Ink 6 and React 19 (rendering).

## Run

```sh
bun install                 # also links ../../minimal-agent-{core,config}
bun run mock                # offline: canned streamed screen
bun run start -- --model claude-haiku-5-5 --provider anthropic "a dashboard of X"
bun run start -- --once --model ... "prompt"   # headless: print the validated JSON
bun run models              # models with structured outputs
bun run schema              # the wire JSON Schema
bun run start -- --no-tools ...                # without WebSearch / Fetch
bun run test                # fast in-process tests (~2 s)
bun run test:e2e            # real PTY end-to-end (~15 s)
bun run check               # tsc + oxlint + biome + all tests
```

Keys: type a prompt + Enter · `1`-`6` or Tab/arrows + Enter picks an action ·
`^O` raw JSON · Esc stops the turn · `^C` quits.

## How it works

| File | Role |
| --- | --- |
| `src/schema.ts` | zod catalog: Screen → sections (full/half/third) → 9 block types, plus actions |
| `src/wire-schema.ts` | zod → JSON Schema (`oneOf`→`anyOf`, `const`→`enum`, `$defs`) |
| `src/agent.ts` | a core `Session` with `outputSchema`; `text_delta` → partial parse; zod validation; 1 repair turn |
| `src/partial-json.ts` | tolerant parser for a JSON prefix (progressive rendering) |
| `src/render.tsx` | Ink components. Each reads loosely, because blocks can be half-streamed |
| `src/app.tsx` | shell: header, sections, action bar, prompt, status |
| `src/tools.ts` | WebSearch + Fetch from the booted host: allow-list filter, guarded executor, slim schemas |
| `src/mock-transport.ts` | a `sendFn` that streams a canned screen (no network) |
| `test/pty.ts` | e2e harness: `Bun.spawn({ terminal })` PTY + `@xterm/headless` screen grid |

## Findings

1. **Anthropic limits schema properties, not bytes.** "The compiled grammar
   is too large" (HTTP 400). Measured on claude-haiku-5-5: 44 object
   properties pass, 48 fail. `$ref`/`$defs` reuse does not help: an 11.9 KB
   schema with `$defs` still failed. The first catalog had 57 properties and
   cards/columns. The fix was a flat layout (`sections` with a `width`) and
   fewer tone fields. A test keeps the schema at or under `PROPERTY_BUDGET = 40`
   (now 39). Other providers were not measured.
2. **A provider error is not a model error.** A repair turn after a 400 sends
   the same request again. `ask()` repairs only a completed turn whose output
   fails zod.
3. **Half-streamed discriminators**: `"type":"keyVa"` would show as an
   unknown block. The renderer treats a prefix of a known type as pending.
4. **Core API fit**: `outputSchema` on `openSession`, deltas through
   `session.run`, and `bootHost` + `resolveAuth` for real credentials were
   enough. No core change was needed. `TransportFn` is not exported, so the
   experiment derives it from `SessionOptions["sendFn"]`.

5. **Tools add to the grammar cost.** With WebSearch + Fetch in the request,
   the same Screen failed again. Two causes. (a) The full plugin input
   schemas (9 + 10 properties): the model now sees only `query` / `url`
   (`SLIM_FIELDS`), and the plugin fills defaults. (b) `reused: "ref"` had
   moved every union variant into its own `$defs` entry: 14 defs + 2 tools
   fail, 2 defs (`Block`, `Tone`) + 2 tools pass. Only `.meta({ id })`
   schemas go to `$defs` now. A real run: 3 searches, 2 fetches, then a valid
   screen with a Sources section.
6. **Multi-round turns**: with tools, a turn has several model responses. The
   screen is the text of the LAST response only. The buffer resets at each
   `turn_started`, so a "Let me search…" preamble never reaches the parser.
7. **Ink key race (found by the in-process tests)**: Ink re-subscribes
   `useInput` in a passive effect, after the frame is drawn. A key pressed
   right after a screen appears went to the stale handler ("1" was typed,
   not run). The handler now reads state from a ref that a layout effect
   updates at commit. The fix passed 210 of 210 reruns.

## Tests (no tmux)

Bun ≥ 1.3.5 has a built-in PTY (`Bun.spawn(cmd, { terminal: { cols, rows,
data } })`, `Bun.Terminal`), but no terminal emulator: you get raw bytes. Ink
redraws in place, so `Bun.stripANSI` on the stream is not the screen.
`@xterm/headless` (pure JS) turns the bytes into a cell grid.

| Layer | File | How | Speed |
| --- | --- | --- | --- |
| L0 pure | `test/core.test.ts`, `test/tools.test.ts` | partial JSON, schema budget, core session with fake transport/host | ms |
| L1 render | `test/render.test.tsx` | ink-testing-library `lastFrame()`, `test.each` + snapshots per block | ms |
| L2 app | `test/app.test.tsx` | `<App>` with a fake `ScreenAgent`, `stdin.write` keys | ms |
| L3 e2e | `test/e2e.test.ts` | `bun run src/main.tsx --mock` on a real PTY, real keys, Ctrl+C exit code | ~3 s/test |

bun:test has no `waitFor` / `expect.poll`: the tests use a small polling
helper. Snapshots are in `test/__snapshots__` (update with `bun test -u`).

## Lint and format setup

- Biome extends `@minimal-agent/config/biome` (format and import order, the
  same as core).
- oxlint extends `@minimal-agent/config/oxlintrc.json` (type-aware,
  `no-floating-promises`) and adds react hooks/keys, `switch-exhaustiveness`,
  `consistent-type-imports`, `no-explicit-any`, `import/no-cycle`, and a
  400-line file limit.
- tsconfig extends `@minimal-agent/config/tsconfig.json`, plus `jsx`,
  `verbatimModuleSyntax`, and `noImplicitReturns`. `noUnusedLocals`,
  `noImplicitOverride`, and `exactOptionalPropertyTypes` are off: tsc also
  checks the linked core source, and core fails them.
- `research/` is git-ignored in the monorepo, and oxlint skips git-ignored
  directories. So `lint` passes explicit file paths with `--no-ignore`.
