/**
 * L2: the App shell in process, with a fake agent (no core, no network).
 * Tests the state machine: streaming → valid, actions by key, errors, tools.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { cleanup, render } from "ink-testing-library"

import type { AskCallbacks, AskResult, ScreenAgent } from "../src/agent.ts"
import { App } from "../src/app.tsx"
import type { Screen } from "../src/schema.ts"

const screenFor = (prompt: string): Screen => ({
  title: `Screen for ${prompt}`,
  sections: [
    {
      title: "Body",
      tone: "normal",
      width: "full",
      blocks: [{ type: "text", text: `you said ${prompt}`, tone: "normal" }],
    },
  ],
  actions: [
    { label: "First", prompt: "first action" },
    { label: "Second", prompt: "second action" },
  ],
})

/** A fake agent. `script` decides each answer; every call is recorded. */
function fakeAgent(
  script: (prompt: string, cb: AskCallbacks) => Promise<AskResult> = async (prompt, cb) => {
    cb.onPartial({ title: `Screen for ${prompt}` }, 10)
    return { ok: true, screen: screenFor(prompt), raw: "{}", repaired: false }
  },
): ScreenAgent & { prompts: string[]; aborted: number } {
  const agent = {
    model: "fake-model",
    toolNames: ["WebSearch", "Fetch"],
    prompts: [] as string[],
    aborted: 0,
    ask: (prompt: string, cb: AskCallbacks) => {
      agent.prompts.push(prompt)
      return script(prompt, cb)
    },
    abort: () => {
      agent.aborted++
    },
    close: () => {},
  }
  return agent
}

/** Poll `lastFrame` until `pred` holds. bun:test has no `waitFor`. */
async function until(get: () => string | undefined, pred: (f: string) => boolean): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const f = Bun.stripANSI(get() ?? "")
    if (pred(f)) return f
    await Bun.sleep(10)
  }
  throw new Error(`until: timed out; frame:\n${Bun.stripANSI(get() ?? "")}`)
}

const noop = (): void => {}

/** Ink reads input on the next tick after mount: give it one. */
const tick = () => Bun.sleep(20)

afterEach(() => cleanup())

describe("App", () => {
  test("runs the initial prompt and shows the screen, tools and actions", async () => {
    const agent = fakeAgent()
    const { lastFrame } = render(<App agent={agent} initialPrompt="hello" />)
    const f = await until(lastFrame, (s) => s.includes("valid"))
    expect(f).toContain("Screen for hello")
    expect(f).toContain("you said hello")
    expect(f).toContain("fake-model · WebSearch Fetch")
    expect(f).toContain("1 First")
    expect(f).toContain("2 Second")
    expect(agent.prompts).toEqual(["hello"])
  })

  test("a digit key runs that action's prompt", async () => {
    const agent = fakeAgent()
    const { lastFrame, stdin } = render(<App agent={agent} initialPrompt="hello" />)
    await until(lastFrame, (s) => s.includes("turn 1"))
    stdin.write("2")
    await until(lastFrame, (s) => s.includes("turn 2"))
    expect(agent.prompts).toEqual(["hello", "second action"])
  })

  test("Tab moves the selection and Enter runs it", async () => {
    const agent = fakeAgent()
    const { lastFrame, stdin } = render(<App agent={agent} initialPrompt="hello" />)
    await until(lastFrame, (s) => s.includes("turn 1"))
    stdin.write("\t")
    await tick()
    stdin.write("\r")
    await until(lastFrame, (s) => s.includes("turn 2"))
    expect(agent.prompts.at(-1)).toBe("second action")
  })

  test("typed text + Enter sends a free prompt", async () => {
    const agent = fakeAgent()
    const { lastFrame, stdin } = render(<App agent={agent} />)
    await tick()
    for (const ch of "hi there") stdin.write(ch)
    await until(lastFrame, (s) => s.includes("› hi there"))
    stdin.write("\r")
    await until(lastFrame, (s) => s.includes("Screen for hi there"))
    expect(agent.prompts).toEqual(["hi there"])
  })

  test("a failed answer shows the error and keeps the last good actions", async () => {
    let n = 0
    const agent = fakeAgent(async (prompt) => {
      n++
      return n === 1
        ? { ok: true, screen: screenFor(prompt), raw: "{}", repaired: false }
        : { ok: false, error: "sections.0.width: Invalid option", raw: "{", partial: null }
    })
    const { lastFrame, stdin } = render(<App agent={agent} initialPrompt="hello" />)
    await until(lastFrame, (s) => s.includes("turn 1"))
    stdin.write("1")
    const f = await until(lastFrame, (s) => s.includes("turn 2"))
    expect(f).toContain("sections.0.width: Invalid option")
    expect(f).toContain("1 First")
  })

  test("tool calls appear as a live log", async () => {
    let finish: (r: AskResult) => void = noop
    const agent = fakeAgent(
      (prompt, cb) =>
        new Promise<AskResult>((resolve) => {
          cb.onTool?.({
            id: "t1",
            name: "WebSearch",
            phase: "start",
            detail: "bun release",
            isError: false,
          })
          finish = resolve
          void prompt
        }),
    )
    const { lastFrame } = render(<App agent={agent} initialPrompt="news" />)
    const running = await until(lastFrame, (s) => s.includes("WebSearch bun release"))
    expect(running).toContain("◌ WebSearch bun release")
    finish({ ok: true, screen: screenFor("news"), raw: "{}", repaired: false })
    await until(lastFrame, (s) => s.includes("valid"))
  })

  test("Esc while streaming aborts the agent", async () => {
    const agent = fakeAgent(() => new Promise<AskResult>(() => {}))
    const { lastFrame, stdin } = render(<App agent={agent} initialPrompt="slow" />)
    await until(lastFrame, (s) => s.includes("generating"))
    stdin.write("\x1b")
    await until(
      () => String(agent.aborted),
      (s) => s === "1",
    )
  })
})
