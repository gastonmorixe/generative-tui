/**
 * Ink components for each catalog block.
 *
 * Every component takes a `Partial`-ish block: while the model streams, a
 * block can lack fields or hold a half string. So each reader below coerces
 * (`str`, `num`, `arr`) instead of trusting the zod type. The same code
 * renders the final, validated screen.
 */

import { Box, Text } from "ink"
import type React from "react"

import { BLOCK_TYPES, type Tone } from "./schema.ts"

type Loose = Record<string, unknown>

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d)
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const obj = (v: unknown): Loose =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : {}

const TONE_COLOR: Record<Tone, string | undefined> = {
  normal: undefined,
  muted: "gray",
  info: "cyan",
  success: "green",
  warning: "yellow",
  error: "red",
  accent: "magenta",
}
const color = (t: unknown): string | undefined => TONE_COLOR[t as Tone]

const clip = (s: string, w: number): string =>
  s.length > w ? `${s.slice(0, Math.max(0, w - 1))}…` : s

/** Render one block. Unknown or still-typeless blocks show a placeholder. */
export function BlockView({ block, width }: { block: unknown; width: number }): React.ReactNode {
  const b = obj(block)
  const type = str(b.type)
  if (!BLOCK_TYPES.has(type)) {
    // A discriminator still streaming ("keyVa") is pending, not unknown.
    const pending = [...BLOCK_TYPES].some((t) => t.startsWith(type))
    return <Text color="gray">{pending ? "⟨…⟩" : `⟨unknown block "${type}"⟩`}</Text>
  }
  switch (type) {
    case "text":
      return <Text color={color(b.tone)}>{str(b.text)}</Text>
    case "list":
      return (
        <Box flexDirection="column">
          {arr(b.items).map((item, i) => (
            <Text key={i}>
              <Text color="gray">• </Text>
              {str(item)}
            </Text>
          ))}
        </Box>
      )
    case "keyValue": {
      const pairs = arr(b.pairs).map(obj)
      const kw = Math.min(24, Math.max(0, ...pairs.map((p) => str(p.key).length)))
      return (
        <Box flexDirection="column">
          {pairs.map((p, i) => (
            <Text key={i}>
              <Text color="gray">{str(p.key).padEnd(kw)} </Text>
              <Text bold>{str(p.value)}</Text>
            </Text>
          ))}
        </Box>
      )
    }
    case "table":
      return (
        <TableView columns={arr(b.columns).map((c) => str(c))} rows={arr(b.rows)} width={width} />
      )
    case "progress": {
      const pct = Math.max(0, Math.min(100, num(b.percent)))
      const labelW = Math.min(16, Math.max(6, Math.floor(width / 3)))
      const barW = Math.max(4, Math.min(40, width - labelW - 6))
      const fill = Math.round((pct / 100) * barW)
      return (
        <Text>
          <Text color="gray">{clip(str(b.label), labelW).padEnd(labelW)} </Text>
          <Text color={color(b.tone) ?? "cyan"}>{"█".repeat(fill)}</Text>
          <Text color="gray">{"░".repeat(barW - fill)}</Text>
          <Text>{String(Math.round(pct)).padStart(4)}%</Text>
        </Text>
      )
    }
    case "badges":
      return (
        <Box flexWrap="wrap" columnGap={1}>
          {arr(b.items)
            .map(obj)
            .map((it, i) => (
              <Text key={i} inverse color={color(it.tone) ?? "white"}>
                {` ${str(it.label)} `}
              </Text>
            ))}
        </Box>
      )
    case "code":
      return (
        <Box borderStyle="single" borderColor="gray" paddingX={1}>
          <Text color="greenBright">{str(b.code)}</Text>
        </Box>
      )
    case "sparkline":
      return <SparklineView label={str(b.label)} values={arr(b.values).map((v) => num(v))} />
    case "barChart":
      return <BarChartView bars={arr(b.bars).map(obj)} unit={str(b.unit)} width={width} />
    default:
      return null
  }
}

/** A vertical stack of blocks. */
export function Blocks({ blocks, width }: { blocks: unknown[]; width: number }): React.ReactNode {
  return (
    <Box flexDirection="column" rowGap={1}>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} width={width} />
      ))}
    </Box>
  )
}

const FRACTION: Record<string, number> = { full: 1, half: 1 / 2, third: 1 / 3 }
/** Below this many columns, every section takes the full width. */
const MIN_SECTION_COLS = 34

/** One bordered section. The tone colors the border and the title. */
function SectionView({ section, width }: { section: Loose; width: number }): React.ReactNode {
  const tone = color(section.tone)
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tone ?? "gray"}
      paddingX={1}
      width={width}
    >
      {section.title ? (
        <Text bold color={tone ?? "cyan"}>
          {str(section.title)}
        </Text>
      ) : null}
      <Blocks blocks={arr(section.blocks)} width={width - 4} />
    </Box>
  )
}

/**
 * Pack sections into rows: consecutive half/third sections share a row
 * while their fractions fit in 1. A narrow terminal stacks every section.
 */
export function packRows(widths: readonly string[], totalWidth: number): number[][] {
  const rows: number[][] = []
  let row: number[] = []
  let used = 0
  widths.forEach((w, i) => {
    const f = FRACTION[w] ?? 1
    const fits = totalWidth * f >= MIN_SECTION_COLS
    if (f === 1 || !fits || used + f > 1.001) {
      if (row.length > 0) rows.push(row)
      row = []
      used = 0
    }
    row.push(i)
    used += fits ? f : 1
  })
  if (row.length > 0) rows.push(row)
  return rows
}

/** All sections of a screen, packed into rows. */
export function Sections({
  sections,
  width,
}: {
  sections: unknown[]
  width: number
}): React.ReactNode {
  const items = sections.map(obj)
  const rows = packRows(
    items.map((s) => str(s.width, "full")),
    width,
  )
  return (
    <Box flexDirection="column">
      {rows.map((row, r) => {
        const gap = row.length - 1
        const each = Math.floor((width - gap) / row.length)
        return (
          <Box key={r} columnGap={1}>
            {row.map((i) => (
              <SectionView key={i} section={items[i] ?? {}} width={each} />
            ))}
          </Box>
        )
      })}
    </Box>
  )
}

function TableView({
  columns,
  rows,
  width,
}: {
  columns: string[]
  rows: unknown[]
  width: number
}) {
  const cells = rows.map((r) => arr(r).map((c) => str(c, typeof c === "number" ? String(c) : "")))
  const n = Math.max(columns.length, ...cells.map((r) => r.length), 1)
  const natural = Array.from({ length: n }, (_, i) =>
    Math.max(str(columns[i]).length, ...cells.map((r) => (r[i] ?? "").length), 1),
  )
  // Shrink the widest column until the row fits.
  const budget = Math.max(n * 4, width - (n - 1) * 3)
  const widths = [...natural]
  while (widths.reduce((a, b) => a + b, 0) > budget) {
    const i = widths.indexOf(Math.max(...widths))
    widths[i] = (widths[i] as number) - 1
  }
  const line = (r: string[]) => widths.map((w, i) => clip(r[i] ?? "", w).padEnd(w)).join(" │ ")
  return (
    <Box flexDirection="column">
      <Text bold>{line(columns)}</Text>
      <Text color="gray">{widths.map((w) => "─".repeat(w)).join("─┼─")}</Text>
      {cells.map((r, i) => (
        <Text key={i}>{line(r)}</Text>
      ))}
    </Box>
  )
}

const SPARK = "▁▂▃▄▅▆▇█"
function SparklineView({ label, values }: { label: string; values: number[] }) {
  if (values.length === 0) return <Text color="gray">{label}</Text>
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const line = values
    .map((v) => SPARK[Math.round(((v - min) / span) * (SPARK.length - 1))])
    .join("")
  return (
    <Text>
      <Text color="gray">{label} </Text>
      <Text color="cyan">{line}</Text>
      <Text color="gray">
        {" "}
        {min}–{max}
      </Text>
    </Text>
  )
}

function BarChartView({ bars, unit, width }: { bars: Loose[]; unit: string; width: number }) {
  const labelW = Math.min(14, Math.max(1, ...bars.map((b) => str(b.label).length)))
  const max = Math.max(1, ...bars.map((b) => Math.abs(num(b.value))))
  const valueW = Math.max(...bars.map((b) => String(num(b.value)).length)) + unit.length + 2
  const barW = Math.max(4, width - labelW - valueW - 1)
  return (
    <Box flexDirection="column">
      {bars.map((b, i) => {
        const v = num(b.value)
        const len = Math.max(0, Math.round((Math.abs(v) / max) * barW))
        return (
          <Text key={i}>
            <Text color="gray">{clip(str(b.label), labelW).padEnd(labelW)} </Text>
            <Text color="cyan">{"■".repeat(len)}</Text>
            <Text>
              {" "}
              {v}
              {unit ? ` ${unit}` : ""}
            </Text>
          </Text>
        )
      })}
    </Box>
  )
}
