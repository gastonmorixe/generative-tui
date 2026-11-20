/**
 * L3: the whole program on a real PTY (`--mock`, no network). Slow (the mock
 * streams for ~2 s per turn), so few tests, run in order, with a retry.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { footer, type PtyApp, spawnApp } from "./pty.ts"

const E2E = { timeout: 30_000, retry: 1 } as const
const isValid = (turn: number) => (s: string) =>
  footer(s).startsWith("valid") && footer(s).includes(`turn ${turn}`)

let app: PtyApp | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
})

describe.serial("main.tsx --mock on a PTY", () => {
  test(
    "streams the first screen, then runs action 2 from a key press",
    async () => {
      app = spawnApp(["--mock", "hello"])
      const first = await app.waitFor(isValid(1))
      expect(first).toContain("Build health #1 · hello")
      expect(first).toContain("2 Compare to last week")
      // The half sections sit side by side at 100 columns.
      expect(first).toMatch(/Pipeline.*│ │.*Latency \(ms\)/)

      app.press("2")
      const second = await app.waitFor(isValid(2))
      expect(second).toContain("Build health #2 · Compare this build health to last week.")
    },
    E2E,
  )

  test(
    "shows a partial screen while streaming",
    async () => {
      app = spawnApp(["--mock", "hello"])
      const mid = await app.waitFor((s) => footer(s).startsWith("generating") && s.includes("╭"))
      expect(footer(mid)).toMatch(/generating… · \d+ B/)
      await app.waitFor(isValid(1))
    },
    E2E,
  )

  test(
    "stacks the half sections on a narrow terminal",
    async () => {
      app = spawnApp(["--mock", "hello"], { cols: 60, rows: 60 })
      const s = await app.waitFor(isValid(1))
      const pipeline = s.split("\n").find((l) => l.includes("Pipeline")) ?? ""
      expect(pipeline).not.toContain("Latency")
    },
    E2E,
  )

  test(
    "^O shows the raw JSON, and Ctrl+C exits with code 0",
    async () => {
      app = spawnApp(["--mock", "hello"])
      await app.waitFor(isValid(1))
      app.press("\x0f") // Ctrl+O
      await app.waitFor((s) => s.includes('"sections"'))
      app.press("\x03")
      expect(await app.exited).toBe(0)
    },
    E2E,
  )
})
