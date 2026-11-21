import { describe, expect, it } from "bun:test"

import { validateAgainstSchema } from "@minimal-agent/core/sdk/output-schema"

import { GenerativeAgent } from "../src/agent.ts"
import { createMockTransport } from "../src/mock-transport.ts"
import { extractJsonText, parsePartialJson } from "../src/partial-json.ts"
import { packRows } from "../src/render.tsx"
import { PROPERTY_BUDGET, Screen } from "../src/schema.ts"
import { schemaStats } from "../src/schema-budget.ts"
import { wireSchema } from "../src/wire-schema.ts"

describe("parsePartialJson", () => {
  it("keeps an open string and closes open containers", () => {
    expect(parsePartialJson('{"title":"Hel')).toEqual({ title: "Hel" })
    expect(parsePartialJson('{"a":[1,2,{"b":"x"')).toEqual({ a: [1, 2, { b: "x" }] })
  })
  it("drops a key with no value and a half literal", () => {
    expect(parsePartialJson('{"a":1,"b"')).toEqual({ a: 1 })
    expect(parsePartialJson('{"a":1,"b":tr')).toEqual({ a: 1 })
    expect(parsePartialJson('{"a":"x\\')).toEqual({ a: "x" })
  })
  it("parses every prefix of a real screen without throwing", async () => {
    const full = await collectMockText()
    for (let i = 0; i < full.length; i++) parsePartialJson(full.slice(0, i))
    expect(parsePartialJson(full)).toEqual(JSON.parse(full))
  })
})

describe("extractJsonText", () => {
  const obj = '{"a":{"b":[1,"}"]},"c":"x"}'
  it("returns a bare object unchanged", () => {
    expect(extractJsonText(obj)).toBe(obj)
    expect(extractJsonText("no json here")).toBe("")
  })
  it("cuts leading and trailing prose", () => {
    expect(extractJsonText(`Here it is: ${obj}\nHope that helps! {}`)).toBe(obj)
  })
  it("cuts a markdown fence, with or without a language tag", () => {
    expect(extractJsonText(`\`\`\`json\n${obj}\n\`\`\``)).toBe(obj)
    expect(extractJsonText(`Sure:\n\`\`\`\n${obj}\n\`\`\`\nDone.`)).toBe(obj)
  })
  it("skips a { in prose before the fence", () => {
    expect(extractJsonText(`Use {braces}:\n\`\`\`json\n${obj}\n\`\`\``)).toBe(obj)
  })
  it("ignores braces, escaped quotes and fences inside strings", () => {
    const code = '{"type":"code","code":"```ts\\nconst s = \\"}\\"\\n```"}'
    expect(extractJsonText(`${code} trailing`)).toBe(code)
    expect(JSON.parse(extractJsonText(code)).type).toBe("code")
  })
  it("returns the rest of an unclosed object (streaming)", () => {
    expect(extractJsonText('prose {"title":"He')).toBe('{"title":"He')
    expect(extractJsonText('{"s":"a\\')).toBe('{"s":"a\\')
  })
  it("matches the mock screen at every prefix", async () => {
    const full = await collectMockText()
    for (let i = 1; i <= full.length; i++) {
      expect(extractJsonText(full.slice(0, i))).toBe(full.slice(full.indexOf("{"), i))
    }
  })
})

describe("wireSchema", () => {
  it("uses anyOf/enum, never oneOf/const", () => {
    const text = JSON.stringify(wireSchema(Screen))
    expect(text).not.toContain('"oneOf"')
    expect(text).not.toContain('"const"')
    expect(text).not.toContain('"$schema"')
  })
  it("puts only the named schemas in $defs (not every union variant)", () => {
    const defs = Object.keys((wireSchema(Screen).$defs ?? {}) as object)
    expect(defs.toSorted()).toEqual(["Block", "Tone"])
  })
  it("stays inside Anthropic's grammar property budget", () => {
    expect(schemaStats(wireSchema(Screen)).properties).toBeLessThanOrEqual(PROPERTY_BUDGET)
  })
  it("agrees with core's own output-schema validator on a zod-valid screen", async () => {
    const screen = Screen.parse(JSON.parse(await collectMockText()))
    expect(validateAgainstSchema(screen, wireSchema(Screen)).valid).toBe(true)
  })
})

describe("GenerativeAgent over a core session", () => {
  it("streams partial screens and returns a zod-valid screen", async () => {
    const agent = await GenerativeAgent.open({
      model: "mock",
      sendFn: createMockTransport({ chunkDelayMs: 0, chunkSize: 40 }),
    })
    const partials: unknown[] = []
    const result = await agent.ask("hello", {
      onPartial: (p) => partials.push(p),
      onStatus: () => {},
    })
    agent.close()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.screen.title).toContain("hello")
    expect(partials.length).toBeGreaterThan(1)
  })

  it("runs one repair turn when the output fails zod", async () => {
    let calls = 0
    const good = await collectMockText()
    const agent = await GenerativeAgent.open({
      model: "mock",
      sendFn: async function* () {
        calls++
        const text = calls === 1 ? '{"title":"x","sections":[{"type":"nope"}]}' : good
        yield text
        return { blocks: [{ type: "text", text }], text, stopReason: "end_turn" }
      },
    })
    const result = await agent.ask("hi", { onPartial: () => {}, onStatus: () => {} })
    agent.close()
    expect(calls).toBe(2)
    expect(result.ok && result.repaired).toBe(true)
  })
})

async function collectMockText(): Promise<string> {
  const gen = createMockTransport({ chunkDelayMs: 0 })({
    auth: { type: "api-key", token: "x" },
    messages: [{ role: "user", content: "test" }],
  })
  let step = await gen.next()
  while (!step.done) step = await gen.next()
  return step.value.text
}

describe("packRows", () => {
  it("puts half and third sections side by side on a wide terminal", () => {
    expect(packRows(["full", "half", "half", "third", "third", "third"], 120)).toEqual([
      [0],
      [1, 2],
      [3, 4, 5],
    ])
  })
  it("starts a new row when the fractions overflow", () => {
    expect(packRows(["half", "third", "half"], 120)).toEqual([[0, 1], [2]])
  })
  it("stacks every section on a narrow terminal", () => {
    expect(packRows(["half", "half"], 50)).toEqual([[0], [1]])
  })
})
