/**
 * End-to-end harness: a real pseudo-terminal (`Bun.spawn({ terminal })`,
 * Bun ≥ 1.3.5) feeding a headless VT emulator (`@xterm/headless`).
 *
 * Bun gives raw PTY bytes only (cursor moves, erase-line, colors). Stripping
 * ANSI from an Ink stream does NOT give the screen, because Ink redraws in
 * place. The emulator applies the bytes to a cell grid, so `screen()` is what
 * a person would see. No tmux.
 */

import { join } from "node:path"

import xterm from "@xterm/headless"

const { Terminal: VtTerminal } = xterm

/** The experiment root: where `src/main.tsx` lives. */
export const APP_DIR = join(import.meta.dir, "..")

export interface PtyApp {
  /** The visible screen, one string per row, trailing blank rows removed. */
  screen(): Promise<string>
  /** Send keystrokes (`"2"`, `"\r"`, `"\x1b"` Esc, `"\x03"` Ctrl+C, `"\x1b[C"` →). */
  press(keys: string): void
  /** Resize the PTY and the emulator together. */
  resize(cols: number, rows: number): void
  /** Poll the screen until `pred` holds. Throws with the last screen on timeout. */
  waitFor(pred: (screen: string) => boolean, timeoutMs?: number): Promise<string>
  /** The child exit code. */
  readonly exited: Promise<number>
  /** Kill the child and free the PTY. Safe to call twice. */
  close(): Promise<void>
}

export interface PtyOptions {
  cols?: number
  rows?: number
}

/** Spawn `bun run src/main.tsx ...args` on a fresh PTY. */
export function spawnApp(args: readonly string[], opts: PtyOptions = {}): PtyApp {
  const cols = opts.cols ?? 100
  const rows = opts.rows ?? 40
  const vt = new VtTerminal({ cols, rows, allowProposedApi: true })
  const proc = Bun.spawn(["bun", "run", "src/main.tsx", ...args], {
    cwd: APP_DIR,
    // `TerminalOptions.name` does not reach the child's TERM: set it here.
    env: { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "1" },
    terminal: { cols, rows, data: (_t, bytes) => vt.write(bytes) },
  })
  const term = proc.terminal
  if (!term) throw new Error("Bun.spawn returned no terminal: PTY support is POSIX only")

  const flush = () => new Promise<void>((resolve) => vt.write("", resolve))
  const screen = async (): Promise<string> => {
    await flush()
    const buf = vt.buffer.active
    const lines: string[] = []
    for (let y = 0; y < vt.rows; y++) {
      lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? "")
    }
    return lines.join("\n").replace(/\n+$/, "")
  }

  let closed = false
  return {
    screen,
    press: (keys) => {
      term.write(keys)
    },
    resize: (c, r) => {
      term.resize(c, r)
      vt.resize(c, r)
    },
    async waitFor(pred, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const s = await screen()
        if (pred(s)) return s
        if (Date.now() > deadline) throw new Error(`waitFor timed out; screen:\n${s}`)
        await Bun.sleep(40)
      }
    },
    exited: proc.exited,
    async close() {
      if (closed) return
      closed = true
      if (proc.exitCode === null) proc.kill()
      await proc.exited
      term.close()
      vt.dispose()
    },
  }
}

/** The last non-blank row: the app's status footer. */
export function footer(screen: string): string {
  return screen.split("\n").findLast((l) => l.trim() !== "") ?? ""
}
