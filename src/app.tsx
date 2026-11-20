/**
 * The TUI shell: a header, the generated screen, the action bar, and a
 * prompt line.
 *
 * Keys:
 *   type + Enter     send a free-text prompt
 *   Tab / ← →        select an action (when the prompt line is empty)
 *   1-6              run that action at once (when the prompt line is empty)
 *   Enter (empty)    run the selected action
 *   Ctrl+O           toggle the raw JSON view
 *   Esc              stop the generation
 *   Ctrl+C           quit
 */

import { Box, Text, useApp, useInput, useStdout } from "ink"
import type React from "react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

import type { AskResult, ScreenAgent } from "./agent.ts"
import { Sections } from "./render.tsx"
import type { Screen } from "./schema.ts"
import type { ToolActivity } from "./tools.ts"

type Phase = "idle" | "streaming" | "error"

interface State {
  phase: Phase
  status: string
  /** The best view so far: partial while streaming, then the validated screen. */
  view: unknown
  /** The last validated screen, kept when a new turn fails. */
  screen: Screen | null
  raw: string
  bytes: number
  turns: number
  ms: number
  /** Tool calls of the current turn, by id, in call order. */
  tools: ToolActivity[]
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

export function App({
  agent,
  initialPrompt,
}: {
  agent: ScreenAgent
  initialPrompt?: string
}): React.ReactNode {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const width = Math.max(40, (stdout.columns ?? 80) - 2)

  const [input, setInput] = useState("")
  const [selected, setSelected] = useState(0)
  const [showRaw, setShowRaw] = useState(false)
  const [s, setS] = useState<State>({
    phase: "idle",
    status: "ready",
    view: null,
    screen: null,
    raw: "",
    bytes: 0,
    turns: 0,
    ms: 0,
    tools: [],
  })
  const abortRef = useRef<AbortController | null>(null)

  const send = useCallback(
    async (prompt: string) => {
      if (abortRef.current) return
      const ac = new AbortController()
      abortRef.current = ac
      const t0 = Date.now()
      setSelected(0)
      setS((p) => ({
        ...p,
        phase: "streaming",
        status: "generating…",
        bytes: 0,
        view: null,
        tools: [],
      }))
      let result: AskResult
      try {
        result = await agent.ask(
          prompt,
          {
            onPartial: (partial, bytes) => setS((p) => ({ ...p, view: partial, bytes })),
            onStatus: (status) => setS((p) => ({ ...p, status })),
            onTool: (activity) =>
              setS((p) => ({
                ...p,
                status: activity.phase === "start" ? `${activity.name}…` : p.status,
                tools: upsertTool(p.tools, activity),
              })),
          },
          ac.signal,
        )
      } catch (error) {
        result = { ok: false, error: String(error), raw: "", partial: null }
      } finally {
        abortRef.current = null
      }
      const ms = Date.now() - t0
      setS((p) =>
        result.ok
          ? {
              ...p,
              phase: "idle",
              status: result.repaired ? "valid after 1 repair" : "valid",
              view: result.screen,
              screen: result.screen,
              raw: result.raw,
              turns: p.turns + 1,
              ms,
            }
          : {
              ...p,
              phase: "error",
              status: result.error.split("\n")[0] ?? "error",
              view: result.partial ?? p.screen,
              raw: result.raw,
              turns: p.turns + 1,
              ms,
            },
      )
    },
    [agent],
  )

  useEffect(() => {
    if (initialPrompt) void send(initialPrompt)
  }, [initialPrompt, send])

  const actions = (s.screen?.actions ?? []).slice(0, 6)
  const busy = s.phase === "streaming"

  // Ink re-subscribes `useInput` in a passive effect, AFTER the frame is
  // drawn. A key that arrives in between reaches the previous handler and its
  // stale state (no actions yet: "1" would be typed, not run). A layout
  // effect runs at commit, before that gap, so the handler reads the state of
  // the last committed render from this ref.
  const live = useRef({ actions, busy, input, selected })
  useLayoutEffect(() => {
    live.current = { actions, busy, input, selected }
  })

  useInput((ch, key) => {
    const { actions, busy, input, selected } = live.current
    if (key.ctrl && ch === "c") {
      abortRef.current?.abort()
      agent.close()
      exit()
      return
    }
    if (key.escape) {
      if (busy) {
        abortRef.current?.abort()
        agent.abort()
      } else setInput("")
      return
    }
    if (key.ctrl && ch === "o") {
      setShowRaw((v) => !v)
      return
    }
    if (busy) return
    if (input === "" && actions.length > 0) {
      if (key.tab || key.rightArrow) return setSelected((i) => (i + 1) % actions.length)
      if (key.leftArrow) return setSelected((i) => (i - 1 + actions.length) % actions.length)
      const n = Number.parseInt(ch, 10)
      if (n >= 1 && n <= actions.length)
        return void send((actions[n - 1] as Screen["actions"][0]).prompt)
      if (key.return) return void send((actions[selected] as Screen["actions"][0]).prompt)
    }
    if (key.return) {
      const prompt = input.trim()
      if (prompt) {
        setInput("")
        void send(prompt)
      }
      return
    }
    if (key.backspace || key.delete) return setInput((v) => v.slice(0, -1))
    if (ch && !key.ctrl && !key.meta && !key.tab) setInput((v) => v + ch)
  })

  const view = obj(s.view)
  const sections = Array.isArray(view.sections) ? view.sections : []
  const title = typeof view.title === "string" ? view.title : busy ? "…" : "Generative TUI"

  return (
    <Box flexDirection="column" width={width + 2}>
      <Box justifyContent="space-between">
        <Text bold color="magentaBright">
          {title}
        </Text>
        <Text color="gray">
          {agent.model}
          {agent.toolNames.length > 0 ? ` · ${agent.toolNames.join(" ")}` : " · no tools"}
        </Text>
      </Box>
      <Text color="gray">{"─".repeat(width)}</Text>
      <ToolLog tools={s.tools} width={width} />

      <Box flexDirection="column" minHeight={3}>
        {showRaw ? (
          <Text color="gray">{s.raw || JSON.stringify(s.view, null, 1) || "(empty)"}</Text>
        ) : sections.length > 0 ? (
          <Sections sections={sections} width={width} />
        ) : (
          <Text color="gray">
            {busy
              ? "waiting for the first block…"
              : "Ask for anything: a dashboard, a comparison, a plan."}
          </Text>
        )}
      </Box>

      <Text color="gray">{"─".repeat(width)}</Text>
      {actions.length > 0 && !busy ? (
        <Box flexWrap="wrap" columnGap={1}>
          {actions.map((a, i) => (
            <Text key={i} inverse={i === selected} color={i === selected ? "cyan" : undefined}>
              {` ${i + 1} ${a.label} `}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box>
        <Text color="cyan">{busy ? "◌ " : "› "}</Text>
        <Text>{input}</Text>
        {!busy ? <Text inverse> </Text> : null}
      </Box>
      <Text color={s.phase === "error" ? "red" : "gray"}>
        {s.status}
        {s.bytes ? ` · ${s.bytes} B` : ""}
        {s.ms && !busy ? ` · ${(s.ms / 1000).toFixed(1)}s` : ""} · turn {s.turns} · ^O raw · esc
        stop · ^C quit
      </Text>
    </Box>
  )
}

/** Replace the entry with the same id, or append. A `done` keeps the start's detail. */
function upsertTool(list: ToolActivity[], a: ToolActivity): ToolActivity[] {
  const i = list.findIndex((t) => t.id === a.id)
  if (i < 0) return [...list, a]
  const prev = list[i] as ToolActivity
  const merged: ToolActivity = { ...a, detail: prev.detail || a.detail }
  return list.map((t, j) => (j === i ? merged : t))
}

/** One line per tool call of the turn: a spinner while it runs, ✓ or ✗ when done. */
function ToolLog({ tools, width }: { tools: ToolActivity[]; width: number }): React.ReactNode {
  if (tools.length === 0) return null
  return (
    <Box flexDirection="column">
      {tools.map((t) => {
        const mark = t.phase === "start" ? "◌" : t.isError ? "✗" : "✓"
        const markColor = t.phase === "start" ? "yellow" : t.isError ? "red" : "green"
        const detail = t.detail.replace(/\s+/g, " ")
        const room = Math.max(10, width - t.name.length - 4)
        return (
          <Text key={t.id}>
            <Text color={markColor}>{mark} </Text>
            <Text bold>{t.name}</Text>
            <Text color="gray">
              {" "}
              {detail.length > room ? `${detail.slice(0, room - 1)}…` : detail}
            </Text>
          </Text>
        )
      })}
    </Box>
  )
}
