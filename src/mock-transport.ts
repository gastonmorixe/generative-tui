/**
 * Offline transport for `--mock`: streams a canned Screen as small JSON
 * chunks, like a real provider streams text deltas. It lets the TUI and the
 * progressive renderer run with no credentials and no network.
 */

import type { TransportFn } from "./agent.ts"
import type { Screen } from "./schema.ts"

const DASHBOARD: Screen = {
  title: "Build health",
  sections: [
    {
      title: null,
      tone: "normal",
      width: "full",
      blocks: [
        {
          type: "text",
          text: "Mock data: the --mock transport streamed this screen.",
          tone: "muted",
        },
        {
          type: "badges",
          items: [
            { label: "main ✓", tone: "success" },
            { label: "3 flaky", tone: "warning" },
            { label: "coverage 87%", tone: "info" },
          ],
        },
      ],
    },
    {
      title: "Pipeline",
      tone: "info",
      width: "half",
      blocks: [
        { type: "progress", label: "unit", percent: 100, tone: "success" },
        { type: "progress", label: "e2e", percent: 64, tone: "warning" },
        { type: "progress", label: "deploy", percent: 10, tone: "muted" },
      ],
    },
    {
      title: "Latency (ms)",
      tone: "accent",
      width: "half",
      blocks: [
        {
          type: "sparkline",
          label: "p95",
          values: [120, 132, 128, 140, 180, 220, 210, 160, 150, 142, 138, 131],
        },
        {
          type: "keyValue",
          pairs: [
            { key: "p50", value: "84" },
            { key: "p95", value: "131" },
          ],
        },
      ],
    },
    {
      title: "Tests per package",
      tone: "normal",
      width: "full",
      blocks: [
        {
          type: "barChart",
          bars: [
            { label: "core", value: 412 },
            { label: "plugins", value: 288 },
            { label: "cli", value: 190 },
            { label: "web", value: 96 },
          ],
          unit: "tests",
        },
        {
          type: "table",
          columns: ["Test", "Fails", "Owner"],
          rows: [
            ["session.resume", "4/50", "core"],
            ["tui.scrollback", "2/50", "cli"],
            ["sse.reconnect", "1/50", "web"],
          ],
        },
      ],
    },
    {
      title: "Next step",
      tone: "warning",
      width: "full",
      blocks: [
        {
          type: "text",
          text: "Quarantine session.resume; it fails on a slow disk only.",
          tone: "normal",
        },
      ],
    },
  ],
  actions: [
    { label: "Show flaky log", prompt: "Show me the log of the session.resume flake." },
    { label: "Compare to last week", prompt: "Compare this build health to last week." },
    { label: "Explain p95 spike", prompt: "Why did p95 latency spike in the middle?" },
  ],
}

export interface MockOptions {
  /** Delay between chunks, ms. */
  chunkDelayMs?: number
  /** Characters per chunk. */
  chunkSize?: number
}

/** A transport that answers every turn with the canned screen, title echoing the prompt. */
export function createMockTransport(opts: MockOptions = {}): TransportFn {
  const delay = opts.chunkDelayMs ?? 12
  const size = opts.chunkSize ?? 9
  let turn = 0
  return async function* (send) {
    turn++
    const last = send.messages.at(-1)
    const prompt =
      last && Array.isArray(last.content)
        ? last.content
            .map((b) => ("text" in b && typeof b.text === "string" ? b.text : ""))
            .join(" ")
        : String(last?.content ?? "")
    const asked = prompt.replace(/\s+/g, " ").trim().slice(0, 80)
    const screen: Screen = { ...DASHBOARD, title: `${DASHBOARD.title} #${turn} · ${asked}` }
    const text = JSON.stringify(screen)
    for (let i = 0; i < text.length; i += size) {
      if (send.signal?.aborted) throw new Error("aborted")
      yield text.slice(i, i + size)
      await Bun.sleep(delay)
    }
    return { blocks: [{ type: "text", text }], text, stopReason: "end_turn" }
  }
}
