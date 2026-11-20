/**
 * Measure a wire JSON Schema the way Anthropic's grammar compiler seems to
 * limit it: by the total count of object properties (see `schema.ts`).
 */

/** Complexity counts of one JSON Schema. */
export interface SchemaStats {
  /** Object properties, summed over every object node (and every `$defs` entry once). */
  properties: number
  /** `anyOf` nodes. */
  unions: number
  /** Nodes with a type array, for example `["string", "null"]`. */
  nullables: number
}

/**
 * Count the complexity of a JSON Schema. Each `$defs` entry counts once,
 * where it is defined, not at each `$ref`.
 */
export function schemaStats(schema: unknown): SchemaStats {
  const acc: SchemaStats = { properties: 0, unions: 0, nullables: 0 }
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n)
      return
    }
    if (!node || typeof node !== "object") return
    const o = node as Record<string, unknown>
    if (o.properties && typeof o.properties === "object") {
      acc.properties += Object.keys(o.properties).length
    }
    if (Array.isArray(o.anyOf)) acc.unions++
    if (Array.isArray(o.type)) acc.nullables++
    for (const v of Object.values(o)) walk(v)
  }
  walk(schema)
  return acc
}
