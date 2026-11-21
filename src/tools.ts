/**
 * Web tools for the generative-UI session: `WebSearch` (ma-web-search-plugin)
 * and `Fetch` (ma-fetch-plugin), from the booted host.
 *
 * The host registry holds every core and plugin tool (Bash, Edit, ...). The
 * advertisement filter offers the model only the two web tools, and the
 * executor refuses any other name, so a model that calls an unadvertised
 * tool cannot run it.
 *
 * SLIM SCHEMAS: Anthropic's grammar budget (see `schema.ts`) counts the tool
 * input properties too. The full plugin schemas have 9 (WebSearch) and 10
 * (Fetch) properties; with the 39 of the Screen the request fails with "The
 * compiled grammar is too large". So the model sees only the fields in
 * {@link SLIM_FIELDS}; the plugin fills every other field with its default.
 */

import type { AgentEvent, SessionOptions } from "@minimal-agent/core"
import type { BootedHost } from "@minimal-agent/core/host-kit/host-boot"
import { createLifecyclePort } from "@minimal-agent/core/host-kit/lifecycle-port-adapter"
import type { ToolDefinition, ToolExecutor, ToolRegistry } from "@minimal-agent/core/sdk/ports"
import { toolFilterFromNamePolicy } from "@minimal-agent/core/sdk/tool-filter"

/** The tools the model may call. */
export const WEB_TOOL_NAMES: readonly string[] = ["WebSearch", "Fetch"]

/** The input fields each web tool keeps on the wire. */
export const SLIM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  WebSearch: ["query"],
  Fetch: ["url"],
}

/** A copy of `def` whose input schema keeps only `fields` (and only those as required). */
export function slimTool(def: ToolDefinition, fields: readonly string[]): ToolDefinition {
  const schema = def.input_schema
  const props = (schema.properties ?? {}) as Record<string, unknown>
  const kept = Object.fromEntries(Object.entries(props).filter(([k]) => fields.includes(k)))
  const required = Array.isArray(schema.required)
    ? schema.required.filter((k): k is string => typeof k === "string" && fields.includes(k))
    : fields.filter((k) => k in kept)
  return {
    ...def,
    input_schema: { type: "object", properties: kept, required, additionalProperties: false },
  }
}

/** One tool call, as the UI shows it. */
export interface ToolActivity {
  id: string
  name: string
  phase: "start" | "done"
  /** Start: the query or the URL. Done: a short result summary. */
  detail: string
  isError: boolean
}

/** What {@link webTools} gives the session. */
export interface WebTools {
  /** The tool names that the host really registers. */
  names: string[]
  /** Spread into `runtime.openSession`. */
  sessionParts: Pick<
    SessionOptions,
    | "toolRegistry"
    | "toolFilter"
    | "toolExecutor"
    | "lifecycle"
    | "syntheticTextProviders"
    | "toolTextProviders"
  >
}

/**
 * Build the tool parts of a session for `model`. Throws when the host
 * registers none of {@link WEB_TOOL_NAMES} (the plugins did not load).
 */
export function webTools(host: BootedHost, model: string): WebTools {
  const registered = new Set(host.toolRegistry.list().map((t) => t.name))
  const names = WEB_TOOL_NAMES.filter((n) => registered.has(n))
  if (names.length === 0) {
    throw new Error(`no web tool loaded: the host registers none of ${WEB_TOOL_NAMES.join(", ")}`)
  }
  const slimRegistry: ToolRegistry = {
    list: () =>
      host.toolRegistry
        .list()
        .filter((t) => allowedNames(names).has(t.name))
        .map((t) =>
          slimTool(t, SLIM_FIELDS[t.name] ?? Object.keys(t.input_schema.properties ?? {})),
        ),
  }
  const inner = host.toolExecutorFor(model)
  const allowed = new Set(names)
  const executor: ToolExecutor = {
    ...(inner.blobStoreEnabled !== undefined ? { blobStoreEnabled: inner.blobStoreEnabled } : {}),
    // Keep the concurrency-safe policy: without it core runs every call serially.
    ...(inner.concurrency ? { concurrency: inner.concurrency } : {}),
    execute: (toolUse, signal, context) =>
      allowed.has(toolUse.name)
        ? inner.execute(toolUse, signal, context)
        : Promise.resolve({ content: `Tool ${toolUse.name} is not available.`, isError: true }),
  }
  return {
    names,
    sessionParts: {
      toolRegistry: slimRegistry,
      toolFilter: toolFilterFromNamePolicy({ kind: "allow-list", tools: names }),
      toolExecutor: executor,
      // Plugin tools run through the loader hooks, as in the web server.
      lifecycle: createLifecyclePort(host.loader.hooks()),
      syntheticTextProviders: host.loader.syntheticTextProviders(),
      toolTextProviders: host.loader.toolTextProviders(),
    },
  }
}

function allowedNames(names: readonly string[]): ReadonlySet<string> {
  return new Set(names)
}

/** The UI view of a tool event, or `null` for an event that is not a tool event. */
export function toolActivityOf(e: AgentEvent): ToolActivity | null {
  if (e.type === "item_started" && e.itemType === "tool_use") {
    const input = e.input ?? {}
    const detail = [input.query, input.url].find((v): v is string => typeof v === "string") ?? ""
    return {
      id: e.id,
      name: e.toolName ?? "tool",
      phase: "start",
      detail,
      isError: false,
    }
  }
  if (e.type === "tool_result") {
    return {
      id: e.id,
      name: e.name,
      phase: "done",
      detail: e.outputSummary ?? e.inputSummary ?? "",
      isError: e.isError,
    }
  }
  return null
}
