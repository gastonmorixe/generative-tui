/**
 * L1: block and section rendering, in process (ink-testing-library, no PTY).
 * The fake stdout is 100 columns wide; `width` props drive the layout.
 */

import { describe, expect, test } from "bun:test"

import { render } from "ink-testing-library"

import { BlockView, Sections } from "../src/render.tsx"
import type { Block, Section } from "../src/schema.ts"

/** Render once, return the plain text frame (no ANSI). */
function frame(node: React.ReactElement): string {
  const { lastFrame, unmount } = render(node)
  const out = Bun.stripANSI(lastFrame() ?? "")
  unmount()
  return out
}

const BLOCKS: [string, Block][] = [
  ["text", { type: "text", text: "hello\nworld", tone: "info" }],
  ["list", { type: "list", items: ["one", "two"] }],
  [
    "keyValue",
    {
      type: "keyValue",
      pairs: [
        { key: "p50", value: "84" },
        { key: "p95", value: "131" },
      ],
    },
  ],
  [
    "table",
    {
      type: "table",
      columns: ["Name", "Fails"],
      rows: [
        ["a", "1"],
        ["bb", "22"],
      ],
    },
  ],
  ["progress", { type: "progress", label: "e2e", percent: 50, tone: "warning" }],
  ["badges", { type: "badges", items: [{ label: "ok", tone: "success" }] }],
  ["code", { type: "code", code: "bun test" }],
  ["sparkline", { type: "sparkline", label: "p95", values: [1, 5, 3, 8] }],
  [
    "barChart",
    {
      type: "barChart",
      bars: [
        { label: "a", value: 10 },
        { label: "b", value: 5 },
      ],
      unit: "ms",
    },
  ],
]

describe("BlockView", () => {
  test.each(BLOCKS)("%s renders a stable frame at 40 columns", (_name, block) => {
    expect(frame(<BlockView block={block} width={40} />)).toMatchSnapshot()
  })

  test("a progress bar is proportional", () => {
    const out = frame(
      <BlockView block={{ type: "progress", label: "x", percent: 50, tone: "info" }} width={40} />,
    )
    const filled = (out.match(/█/g) ?? []).length
    const empty = (out.match(/░/g) ?? []).length
    // An odd bar width rounds the half cell up: allow a difference of one.
    expect(Math.abs(filled - empty)).toBeLessThanOrEqual(1)
    expect(out).toContain("50%")
  })

  test("a table clips cells to fit the width", () => {
    const long = "x".repeat(80)
    const out = frame(
      <BlockView block={{ type: "table", columns: ["A", "B"], rows: [[long, long]] }} width={30} />,
    )
    for (const line of out.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(30)
    expect(out).toContain("…")
  })

  test.each([
    ["a half-streamed type", { type: "keyVa" }, "⟨…⟩"],
    ["a block with no type yet", {}, "⟨…⟩"],
    ["an unknown type", { type: "chart3d" }, '⟨unknown block "chart3d"⟩'],
  ])("%s shows a placeholder", (_name, block, expected) => {
    expect(frame(<BlockView block={block} width={40} />)).toBe(expected)
  })

  test("a half-streamed block renders what it has, without throwing", () => {
    const out = frame(<BlockView block={{ type: "table", columns: ["A", "B"] }} width={40} />)
    expect(out).toContain("A")
  })
})

const section = (title: string, width: Section["width"]): Section => ({
  title,
  tone: "normal",
  width,
  blocks: [{ type: "text", text: title.toLowerCase(), tone: "normal" }],
})

describe("Sections", () => {
  test("two half sections share one row at 100 columns", () => {
    const out = frame(
      <Sections sections={[section("Left", "half"), section("Right", "half")]} width={100} />,
    )
    const titleRow = out.split("\n").find((l) => l.includes("Left")) ?? ""
    expect(titleRow).toContain("Right")
  })

  test("they stack at 50 columns", () => {
    const out = frame(
      <Sections sections={[section("Left", "half"), section("Right", "half")]} width={50} />,
    )
    const titleRow = out.split("\n").find((l) => l.includes("Left")) ?? ""
    expect(titleRow).not.toContain("Right")
  })

  test("a full dashboard frame", () => {
    expect(
      frame(
        <Sections
          sections={[
            section("Summary", "full"),
            section("A", "third"),
            section("B", "third"),
            section("C", "third"),
          ]}
          width={90}
        />,
      ),
    ).toMatchSnapshot()
  })
})
