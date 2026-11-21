# Testing

```sh
bun run test       # L0–L2, in-process, ~2 s
bun run test:e2e   # L3, real PTY, ~15 s
bun run check      # tsc + oxlint + biome + all tests
bun test -u        # update the snapshots
```

## Layers

| Layer | File | What it tests | How |
| --- | --- | --- | --- |
| L0 pure | `test/core.test.ts` | partial JSON, schema budget, a core session with a fake transport/host | plain asserts |
| L0 pure | `test/tools.test.ts` | slim schemas, allow-list, executor guard, Screen + tools budget | fake host |
| L1 render | `test/render.test.tsx` | each block type | ink-testing-library `lastFrame()`, `test.each` + snapshots |
| L2 app | `test/app.test.tsx` | keys, actions, errors, tool log, Esc abort | `<App>` with a fake `ScreenAgent`, `stdin.write` |
| L3 e2e | `test/e2e.test.ts` | the real binary in `--mock` mode | PTY + terminal emulator |

The snapshots are in `test/__snapshots__/render.test.tsx.snap`.

## The PTY harness (`test/pty.ts`)

Bun ≥ 1.3.5 has a built-in PTY: `Bun.spawn(cmd, { terminal: { cols, rows, data } })`.
It gives only **raw bytes**. Ink redraws in place with cursor moves, so
`Bun.stripANSI` on the stream does not give what is on the screen.
`@xterm/headless` (pure JS) applies the bytes to a cell grid.

`PtyApp` API:

- `screen()`: the visible rows. Blank rows at the end are removed.
- `press(keys)`: for example `"2"`, `"\r"`, `"\x1b"` (Esc), `"\x03"` (^C), `"\x1b[C"` (→).
- `resize(cols, rows)`: resizes the PTY and the emulator together.
- `waitFor(pred, timeoutMs?)`: polls the screen. On a timeout, it throws
  with the last screen.
- `exited`: the exit code of the child process.

No tmux is needed.

## Polling

bun:test has no `waitFor` and no `expect.poll`, so the tests use a small
polling helper. Wait for what appears on the screen. Do not use a fixed sleep.

## Mock transport (`src/mock-transport.ts`)

This is a `sendFn` that streams a built-in "Build health" dashboard in small
chunks, the same way a provider streams text deltas. It needs no network and
no credentials. `bun run mock` and the e2e tests use it.
