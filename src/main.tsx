/**
 * Entry point.
 *
 *   bun run src/main.tsx --mock                    offline, canned streamed screen
 *   bun run src/main.tsx --model claude-sonnet-4-6 [--provider anthropic] [--credential NAME]
 *   bun run src/main.tsx --list-models             models with structured outputs
 *   bun run src/main.tsx --once "prompt" [...]     headless: print the validated Screen JSON
 *   bun run src/main.tsx --schema                  print the wire JSON Schema
 *   --no-tools                                     no WebSearch / Fetch (default: both on)
 */

import { parseArgs } from "node:util"

import { render } from "ink"

import { bootProviders, GenerativeAgent } from "./agent.ts"
import { App } from "./app.tsx"
import { createMockTransport } from "./mock-transport.ts"
import { Screen } from "./schema.ts"
import { wireSchema } from "./wire-schema.ts"

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mock: { type: "boolean" },
    model: { type: "string" },
    provider: { type: "string" },
    credential: { type: "string" },
    "list-models": { type: "boolean" },
    once: { type: "boolean" },
    schema: { type: "boolean" },
    "no-tools": { type: "boolean" },
  },
})

if (values.schema) {
  console.log(JSON.stringify(wireSchema(Screen), null, 2))
  process.exit(0)
}

async function openAgent(): Promise<GenerativeAgent> {
  if (values.mock) {
    return GenerativeAgent.open({ model: "mock", sendFn: createMockTransport() })
  }
  const host = await bootProviders()
  if (values["list-models"]) {
    for (const m of host.models) {
      if (m.capabilities?.structuredOutputs) console.log(`${m.providerId.padEnd(16)} ${m.id}`)
    }
    process.exit(0)
  }
  const model = values.model ?? host.defaultModelId
  const row =
    host.models.find(
      (m) => m.id === model && (!values.provider || m.providerId === values.provider),
    ) ?? null
  if (!row) {
    console.error(`unknown model "${model}". Try --list-models.`)
    process.exit(2)
  }
  if (row.capabilities?.structuredOutputs === false) {
    console.error(
      `warning: ${row.id} declares no structured outputs; relying on the prompt + zod repair.`,
    )
  }
  return GenerativeAgent.open({
    host,
    model: row.id,
    providerId: row.providerId,
    ...(values.credential ? { credentialName: values.credential } : {}),
    tools: values["no-tools"] !== true,
  })
}

const agent = await openAgent()
const prompt = positionals.join(" ").trim()

if (values.once) {
  const result = await agent.ask(prompt || "Show me an overview of what you can render.", {
    onPartial: (_p, bytes) => process.stderr.write(`\r${bytes} B`),
    onStatus: (s) => process.stderr.write(`\n[${s}]\n`),
    onTool: (t) => process.stderr.write(`\n[${t.phase} ${t.name}: ${t.detail.slice(0, 120)}]\n`),
  })
  process.stderr.write("\n")
  agent.close()
  if (result.ok) {
    console.log(JSON.stringify(result.screen, null, 2))
    process.exit(0)
  }
  console.error(result.error)
  console.error(result.raw)
  process.exit(1)
}

const app = render(<App agent={agent} {...(prompt ? { initialPrompt: prompt } : {})} />, {
  exitOnCtrlC: false,
})
await app.waitUntilExit()
process.exit(0)
