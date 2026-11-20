/**
 * The generative-UI agent: one minimal-agent core `Session` whose every turn
 * must answer with one `Screen` (see `schema.ts`).
 *
 * Flow of one `ask(prompt)`:
 *   1. `session.run(prompt)` with the zod-derived JSON Schema as the session
 *      `outputSchema`. Core's request codec puts it on the wire in the
 *      provider's structured-output form.
 *   2. Each `text_delta` grows a buffer. The buffer is parsed as a JSON
 *      prefix and handed to `onPartial`, so the TUI paints while it streams.
 *   3. At the end, zod validates the full text. On a failure the agent runs
 *      ONE repair turn that names the zod issues, then gives up.
 *
 * Tools: with a booted host, the session gets `WebSearch` and `Fetch` from the
 * plugins (see `tools.ts`). A turn can then have several rounds: tool calls
 * first, the Screen JSON last. Only the text of the LAST text item is the
 * screen, so the buffer resets at each `turn_started` (one per response).
 */

import {
  createRuntime,
  type Runtime,
  type Session,
  type SessionEntry,
  type SessionOptions,
} from "@minimal-agent/core"
import { type BootedHost, bootHost } from "@minimal-agent/core/host-kit/host-boot"
import type { z } from "zod"

import { extractJsonText, parsePartialJson } from "./partial-json.ts"
import { Screen } from "./schema.ts"
import { SYSTEM_PROMPT } from "./system-prompt.ts"
import { type ToolActivity, toolActivityOf, webTools } from "./tools.ts"
import { wireSchema } from "./wire-schema.ts"

/** Core keeps `TransportFn` unexported (spec 2.7); derive it from the public options. */
export type TransportFn = NonNullable<SessionOptions["sendFn"]>

export interface AskCallbacks {
  /** A best-effort parse of the JSON so far. Not schema-valid. */
  onPartial(partial: unknown, bytes: number): void
  /** A status line for the UI footer. */
  onStatus(text: string): void
  /** A tool call started or finished. Optional. */
  onTool?(activity: ToolActivity): void
}

export type AskResult =
  | { ok: true; screen: Screen; raw: string; repaired: boolean }
  | { ok: false; error: string; raw: string; partial: unknown }

export interface AgentOptions {
  model: string
  providerId?: string
  credentialName?: string
  /** Replace the provider transport (mock mode, tests). */
  sendFn?: TransportFn
  /** Booted host, for the real provider path and the web tools. */
  host?: BootedHost
  /** Give the model WebSearch and Fetch. Default: true when `host` is set. */
  tools?: boolean
}

/** What the TUI needs from an agent. Tests pass a fake. */
export interface ScreenAgent {
  readonly model: string
  readonly toolNames: readonly string[]
  ask(prompt: string, cb: AskCallbacks, signal?: AbortSignal): Promise<AskResult>
  abort(): void
  close(): void
}

/** Max repair turns after a zod failure. */
const MAX_REPAIRS = 1

export class GenerativeAgent implements ScreenAgent {
  private readonly runtime: Runtime
  private readonly session: Session
  readonly model: string
  /** The tool names the model can call. Empty when tools are off. */
  readonly toolNames: readonly string[]

  private constructor(runtime: Runtime, session: Session, model: string, toolNames: string[]) {
    this.runtime = runtime
    this.session = session
    this.model = model
    this.toolNames = toolNames
  }

  /** Open a session. With `host`, the auth comes from the agent's auth store. */
  static async open(opts: AgentOptions): Promise<GenerativeAgent> {
    const runtime = createRuntime()
    const auth = opts.sendFn
      ? ({ type: "api-key", token: "mock" } as const)
      : await requireHost(opts).resolveAuth(opts.model, opts.providerId, opts.credentialName)
    const tools = opts.host && opts.tools !== false ? webTools(opts.host, opts.model) : null
    const session = runtime.openSession({
      auth,
      model: opts.model,
      ...(opts.providerId ? { providerId: opts.providerId } : {}),
      ...(opts.credentialName ? { credentialName: opts.credentialName } : {}),
      ...(opts.sendFn ? { sendFn: opts.sendFn } : {}),
      systemPrompt: SYSTEM_PROMPT,
      outputSchema: wireSchema(Screen),
      maxTokens: 8192,
      ...(tools ? tools.sessionParts : {}),
    })
    return new GenerativeAgent(runtime, session, opts.model, tools?.names ?? [])
  }

  /** Run one user turn, with up to {@link MAX_REPAIRS} repair turns. */
  async ask(prompt: string, cb: AskCallbacks, signal?: AbortSignal): Promise<AskResult> {
    let input = prompt
    let last: AskResult | undefined
    for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
      cb.onStatus(attempt === 0 ? "generating…" : "repairing invalid output…")
      const { text: raw, outcome } = await this.streamTurn(input, cb, signal)
      // A transport or provider failure is not a model mistake: a repair turn
      // would send the same request again. Stop here.
      if (outcome !== "completed") {
        const json = extractJsonText(raw)
        return { ok: false, error: `turn ${outcome}`, raw, partial: safePartial(json) }
      }
      const json = extractJsonText(raw)
      let parsed: unknown
      try {
        parsed = JSON.parse(json)
      } catch (error) {
        last = { ok: false, error: `not JSON: ${String(error)}`, raw, partial: safePartial(json) }
        input = repairPrompt(["The answer was not one complete JSON object."])
        continue
      }
      const result = Screen.safeParse(parsed)
      if (result.success) return { ok: true, screen: result.data, raw, repaired: attempt > 0 }
      const issues = result.error.issues.slice(0, 8).map(formatIssue)
      last = { ok: false, error: issues.join("\n"), raw, partial: parsed }
      input = repairPrompt(issues)
      if (signal?.aborted) break
    }
    return last as AskResult
  }

  /** One `session.run`: returns the full assistant text. */
  private async streamTurn(
    input: string,
    cb: AskCallbacks,
    signal?: AbortSignal,
  ): Promise<{ text: string; outcome: string }> {
    let text = ""
    let lastError = ""
    let finalText: string | undefined
    let lastPaint = 0
    const run = this.session.run(input, { ...(signal ? { signal } : {}), emitDeltas: true })
    for await (const entry of run as AsyncIterable<SessionEntry>) {
      if (entry.ch !== "event") continue
      const e = entry.data
      if (e.type === "turn_started") {
        // One model response per turn_started. An earlier response of this
        // run ended in tool calls; its text was a preamble, not the screen.
        text = ""
        finalText = undefined
      } else if (e.type === "text_delta") {
        text += e.text
        // Throttle: parse at most every 30 ms. Ink batches renders anyway.
        const now = Date.now()
        if (now - lastPaint > 30) {
          lastPaint = now
          cb.onPartial(safePartial(extractJsonText(text)), text.length)
        }
      } else if (e.type === "item_completed" && e.itemType === "text") {
        finalText = e.text
      } else if (cb.onTool && (e.type === "item_started" || e.type === "tool_result")) {
        const activity = toolActivityOf(e)
        if (activity) cb.onTool(activity)
      } else if (e.type === "error") {
        lastError = e.message
        cb.onStatus(`error: ${e.message}`)
      }
    }
    const result = await run.result
    if (result.outcome !== "completed") {
      cb.onStatus(lastError ? `error: ${lastError.slice(0, 200)}` : `turn ${result.outcome}`)
    }
    const full = finalText ?? text ?? result.text ?? ""
    cb.onPartial(safePartial(extractJsonText(full)), full.length)
    return { text: full, outcome: result.outcome }
  }

  abort(): void {
    this.session.abort()
  }

  close(): void {
    this.runtime.close()
  }
}

function requireHost(opts: AgentOptions): BootedHost {
  if (!opts.host) throw new Error("a booted host is required without sendFn")
  return opts.host
}

function safePartial(text: string): unknown {
  try {
    return parsePartialJson(text)
  } catch {
    return undefined
  }
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)"
  return `${path}: ${issue.message}`
}

function repairPrompt(issues: string[]): string {
  return [
    "Your last answer did not match the Screen schema. Problems:",
    ...issues.map((i) => `- ${i}`),
    "Answer again with the same content as ONE valid Screen JSON object, nothing else.",
  ].join("\n")
}

/** The plugin roots for a dev checkout: the sibling plugins repo, then the user home. */
export async function bootProviders(): Promise<BootedHost> {
  const { join } = await import("node:path")
  const { homedir } = await import("node:os")
  const repoPlugins = join(import.meta.dir, "..", "..", "..", "minimal-agent-plugins")
  const home = process.env.MINIMAL_AGENT_HOME ?? join(homedir(), ".minimal-agent")
  // The CLI advertises the managed binary dir (startup/session-env.ts); bare
  // `bootHost` does not. Without it ma-fetch cannot find `obscura` and hides Fetch.
  process.env.MINIMAL_AGENT_BIN_DIR ??= join(home, "bin")
  return bootHost({
    pluginRoots: {
      embedded: [repoPlugins],
      user: [join(home, "plugins")],
    },
    allowBareCore: true,
  })
}
