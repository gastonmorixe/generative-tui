# The Screen schema

Source: `src/schema.ts`. To print the JSON Schema that goes on the wire, run
`bun run schema`.

## Catalog

```
Screen
├─ title: string
├─ sections: Section[]
│   ├─ title: string | null
│   ├─ tone: Tone                     border color; warning/error/success = callout
│   ├─ width: "full" | "half" | "third"
│   └─ blocks: Block[]
└─ actions: Action[]                  2 to 6 follow-ups
    ├─ label: string                  1 to 4 words
    └─ prompt: string                 the message sent when the user picks the action

Tone = normal | muted | info | success | warning | error | accent
```

| Block `type` | Fields |
| --- | --- |
| `text` | `text`, `tone` |
| `list` | `items: string[]` |
| `keyValue` | `pairs: {key, value}[]` |
| `table` | `columns: string[]`, `rows: string[][]` |
| `progress` | `label`, `percent` (0–100), `tone` |
| `badges` | `items: {label, tone}[]` |
| `code` | `code` |
| `sparkline` | `label`, `values: number[]` (5–40 points) |
| `barChart` | `bars: {label, value}[]`, `unit: string \| null` |

`Block` is a zod `discriminatedUnion` on `type`. `BLOCK_TYPES` is the set of
known type names, and the renderer uses it (see [streaming.md](streaming.md)).

## Rules for a portable schema

These rules let one schema work with Anthropic, OpenAI strict, and generic
structured-output endpoints:

1. **Every object is strict** (`z.strictObject` → `additionalProperties: false`).
2. **Every key is required.** To make a field "optional", use `.nullable()`,
   not `.optional()`. OpenAI strict requires every key.
3. **No recursion.** The layout is flat: sections have a `width`, and the
   renderer puts them side by side. Nested cards or columns were removed.
4. **No numeric or length constraints on the wire.** Ranges go in
   `.describe()` text, and the renderer clamps the values.

## Wire conversion (`src/wire-schema.ts`)

`wireSchema(schema)` calls `z.toJSONSchema` (draft 2020-12, output types), then
normalizes the result:

| Change | Why |
| --- | --- |
| `oneOf` → `anyOf` | OpenAI strict rejects `oneOf` |
| `const: x` → `enum: [x]` | Older strict validators and core's `validateAgainstSchema` know only `enum` |
| Remove top-level `$schema` | Some endpoints reject it |
| Only `.meta({ id })` schemas go to `$defs` (`Tone`, `Block`) | `reused: "ref"` puts each union variant in its own def, and that is over budget with tools |

## Property budget

Anthropic's grammar compiler rejects a large schema with HTTP 400 "The compiled
grammar is too large". The limit is on the **total number of object
properties**. The byte size does not matter, and `$ref` reuse does not help.

- Measured on `claude-haiku-5-5` (2026-11-19): 44 properties pass, 48 fail.
- **Tool input schemas count too.** The budget applies to the whole request.
- `schemaStats()` (`src/schema-budget.ts`) counts the properties. It counts
  each `$defs` entry once.
- `PROPERTY_BUDGET = 42` (`src/schema.ts`). Two tests enforce it:
  - `test/core.test.ts`: the Screen alone is ≤ budget.
  - `test/tools.test.ts`: the Screen + slim tools is ≤ budget.

Current count (2026-11-20): **Screen 39 + WebSearch 1 + Fetch 1 = 41.**
Headroom: 1 property. To add a block type or a field, you must remove another,
or measure again on the real provider. Other providers were not measured.

To check the count:

```sh
bun -e 'import {schemaStats} from "./src/schema-budget.ts";import {wireSchema} from "./src/wire-schema.ts";import {Screen} from "./src/schema.ts";console.log(schemaStats(wireSchema(Screen)))'
```

## System prompt (`src/system-prompt.ts`)

The schema says *what* is valid. The system prompt says *what is good*:

- Pick the block that fits the data.
- Use half or third sections in pairs or triples for comparisons.
- Use one callout for the key point.
- Keep cells short (the terminal is 60–120 columns).
- Use tone for meaning, not decoration.
- Do not invent precise numbers.
- With tools, add a final "Sources" section.
