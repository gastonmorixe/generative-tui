import { describe, expect, it } from "bun:test"

import { createRuntime } from "@minimal-agent/core"
import type { BootedHost } from "@minimal-agent/core/host-kit/host-boot"

import type { TransportFn } from "../src/agent.ts"
import { PROPERTY_BUDGET, Screen } from "../src/schema.ts"
import { schemaStats } from "../src/schema-budget.ts"
import { type ToolActivity, toolActivityOf, webTools } from "../src/tools.ts"

const SCREEN = JSON.stringify({ title: "From the web", sections: [], actions: [] })

/** A tool def with many properties, like the real plugin schemas. */
const def = (name: string) => ({
  name,
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      url: { type: "string" },
      count: { type: "integer" },
      format: { type: "string" },
      lang: { type: "string" },
    },
    required: name === "Fetch" ? ["url"] : ["query"],
  },
})

/** A fake host: three registered tools; the executor echoes the call. */
function fakeHost(calls: string[]): BootedHost {
  const host = {
    toolRegistry: { list: () => [def("Bash"), def("WebSearch"), def("Fetch")] },
    toolExecutorFor: () => ({
      execute: async (toolUse: { name: string }) => {
        calls.push(toolUse.name)
        return { content: `results of ${toolUse.name}`, isError: false }
      },
    }),
    loader: {
      hooks: () => ({}),
      syntheticTextProviders: () => [],
      toolTextProviders: () => [],
    },
  }
  return host as unknown as BootedHost
}

describe("webTools", () => {
  it("advertises only WebSearch and Fetch, and refuses other names", async () => {
    const calls: string[] = []
    const tools = webTools(fakeHost(calls), "m")
    expect(tools.names).toEqual(["WebSearch", "Fetch"])
    const offered = tools.sessionParts.toolFilter?.filter(
      tools.sessionParts.toolRegistry?.list() ?? [],
    )
    expect(offered?.map((t) => t.name)).toEqual(["WebSearch", "Fetch"])
    const denied = await tools.sessionParts.toolExecutor?.execute({
      type: "tool_use",
      id: "x",
      name: "Bash",
      input: {},
    })
    expect(denied?.isError).toBe(true)
    expect(calls).toEqual([])
  })

  it("keeps the Screen plus the slim tools inside the grammar budget", async () => {
    const { wireSchema } = await import("../src/wire-schema.ts")
    const tools = webTools(fakeHost([]), "m").sessionParts.toolRegistry?.list() ?? []
    expect(tools.map((t) => Object.keys(t.input_schema.properties as object))).toEqual([
      ["query"],
      ["url"],
    ])
    const total =
      schemaStats(wireSchema(Screen)).properties +
      tools.reduce((n, t) => n + schemaStats(t.input_schema).properties, 0)
    expect(total).toBeLessThanOrEqual(PROPERTY_BUDGET)
  })
})

describe("a turn with a tool round", () => {
  it("runs WebSearch, then takes only the last response as the screen", async () => {
    let round = 0
    const sendFn: TransportFn = async function* () {
      round++
      if (round === 1) {
        // A preamble text, then a tool call: not the screen.
        yield "Let me search."
        return {
          blocks: [
            { type: "text", text: "Let me search." },
            { type: "tool_use", id: "t1", name: "WebSearch", input: { query: "bun 2" } },
          ],
          text: "Let me search.",
          stopReason: "tool_use",
        }
      }
      yield SCREEN
      return { blocks: [{ type: "text", text: SCREEN }], text: SCREEN, stopReason: "end_turn" }
    }
    const calls: string[] = []
    // The fake host has no hook bus: drop the lifecycle port (core default: no hooks).
    const { lifecycle: _lifecycle, ...parts } = webTools(fakeHost(calls), "mock").sessionParts
    const runtime = createRuntime()
    const session = runtime.openSession({
      auth: { type: "api-key", token: "x" },
      model: "mock",
      sendFn,
      ...parts,
    })
    const activity: ToolActivity[] = []
    let lastText = ""
    for await (const e of session.run("what is new in bun?")) {
      if (e.ch !== "event") continue
      const a = toolActivityOf(e.data)
      if (a) activity.push(a)
      if (e.data.type === "item_completed" && e.data.itemType === "text")
        lastText = e.data.text ?? ""
    }
    runtime.close()
    expect(calls).toEqual(["WebSearch"])
    expect(activity.map((a) => `${a.phase}:${a.name}:${a.detail}`)[0]).toBe("start:WebSearch:bun 2")
    expect(activity.at(-1)?.phase).toBe("done")
    expect(lastText).toBe(SCREEN)
  })
})
