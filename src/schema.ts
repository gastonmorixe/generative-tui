/**
 * The generative UI catalog: the only components the model may emit.
 *
 * Rules that keep the schema portable across providers' structured-output
 * modes (Anthropic, OpenAI strict, generic endpoints):
 * - every object is strict (`additionalProperties: false`) and every key is
 *   required; "optional" means `.nullable()`, never `.optional()`.
 * - no recursion. Layout is flat: a Screen is a list of sections, each with
 *   a `width`; the renderer packs half and third sections side by side.
 * - no numeric/length constraints on the wire; ranges live in `.describe()`
 *   text and the renderer clamps.
 * - PROPERTY BUDGET: Anthropic's grammar compiler rejects a schema with
 *   too many object properties in total ("The compiled grammar is too
 *   large"). Measured on claude-haiku-5-5: 44 properties pass, 48 fail;
 *   bytes and `$ref` reuse do not matter. `schema-budget.ts` counts them
 *   and a test keeps the catalog at or under {@link PROPERTY_BUDGET}.
 */

import { z } from "zod"

/**
 * Max object properties across the whole request: the Screen schema PLUS the
 * input schemas of every advertised tool. See the module doc.
 */
export const PROPERTY_BUDGET = 42

export const Tone = z
  .enum(["normal", "muted", "info", "success", "warning", "error", "accent"])
  .describe("Semantic color: meaning, not decoration")
  .meta({ id: "Tone" })
export type Tone = z.infer<typeof Tone>

const Text = z.strictObject({
  type: z.literal("text"),
  text: z.string().describe("Plain text. Use \\n for line breaks. No markdown."),
  tone: Tone,
})

const List = z.strictObject({
  type: z.literal("list"),
  items: z.array(z.string()),
})

const KeyValue = z.strictObject({
  type: z.literal("keyValue"),
  pairs: z.array(z.strictObject({ key: z.string(), value: z.string() })),
})

const Table = z.strictObject({
  type: z.literal("table"),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.string())).describe("Each row has one cell per column"),
})

const Progress = z.strictObject({
  type: z.literal("progress"),
  label: z.string(),
  percent: z.number().describe("0 to 100"),
  tone: Tone,
})

const Badges = z.strictObject({
  type: z.literal("badges"),
  items: z.array(z.strictObject({ label: z.string(), tone: Tone })),
})

const Code = z.strictObject({
  type: z.literal("code"),
  code: z.string(),
})

const Sparkline = z.strictObject({
  type: z.literal("sparkline"),
  label: z.string(),
  values: z.array(z.number()).describe("A short numeric series, 5 to 40 points"),
})

const BarChart = z.strictObject({
  type: z.literal("barChart"),
  bars: z.array(z.strictObject({ label: z.string(), value: z.number() })),
  unit: z.string().nullable(),
})

export const Block = z
  .discriminatedUnion("type", [
    Text,
    List,
    KeyValue,
    Table,
    Progress,
    Badges,
    Code,
    Sparkline,
    BarChart,
  ])
  .meta({ id: "Block" })
export type Block = z.infer<typeof Block>

export const SectionWidth = z
  .enum(["full", "half", "third"])
  .describe("half and third sections sit side by side when the terminal is wide enough")
export type SectionWidth = z.infer<typeof SectionWidth>

export const Section = z.strictObject({
  title: z.string().nullable(),
  tone: Tone.describe("Border color. warning/error/success make the section a callout."),
  width: SectionWidth,
  blocks: z.array(Block),
})
export type Section = z.infer<typeof Section>

export const Action = z.strictObject({
  label: z.string().describe("Short button label, 1 to 4 words"),
  prompt: z.string().describe("The user message sent to you when the user picks this action"),
})
export type Action = z.infer<typeof Action>

/** One full screen. The model answers every turn with exactly one. */
export const Screen = z.strictObject({
  title: z.string(),
  sections: z.array(Section),
  actions: z.array(Action).describe("2 to 6 follow-ups the user can pick"),
})
export type Screen = z.infer<typeof Screen>

/** Every block `type` the renderer knows. */
export const BLOCK_TYPES: ReadonlySet<string> = new Set(
  Block.options.map((o) => o.shape.type.value),
)
