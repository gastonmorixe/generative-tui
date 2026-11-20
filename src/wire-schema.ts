/**
 * Zod schema → JSON Schema in the shape that structured-output endpoints
 * accept most widely.
 *
 * - `oneOf` → `anyOf` (OpenAI strict rejects `oneOf`; Anthropic accepts both).
 * - `const: x` → `enum: [x]` (older strict validators and core's own
 *   `validateAgainstSchema` only know `enum`).
 * - drop the top-level `$schema` key.
 * - only schemas with a `.meta({ id })` (`Tone`, `Block`) go into `$defs`.
 *   Do NOT use `reused: "ref"`: it moves every union variant into its own
 *   `$defs` entry. With tools in the request, Anthropic then refuses the
 *   schema ("The compiled grammar is too large"). Measured on
 *   claude-haiku-5-5: 14 defs + 2 tools fail, 2 defs + 2 tools pass.
 */

import { z } from "zod"

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

function normalize(node: Json): Json {
  if (Array.isArray(node)) return node.map(normalize)
  if (node === null || typeof node !== "object") return node
  const out: { [k: string]: Json } = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema") continue
    if (key === "oneOf") out.anyOf = normalize(value)
    else if (key === "const") out.enum = [value]
    else out[key] = normalize(value)
  }
  return out
}

/** The JSON Schema object for `outputSchema` on a core run. */
export function wireSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, {
    io: "output",
    target: "draft-2020-12",
  }) as Json
  return normalize(raw) as Record<string, unknown>
}
