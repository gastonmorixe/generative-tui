# Docs

Documentation for the generative TUI experiment. The top-level
[`README.md`](../README.md) is the quick start. These pages explain how it works.

| Page | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | The parts, how one turn flows, and the file map |
| [schema.md](schema.md) | The `Screen` catalog, the rules for the wire schema, the property budget |
| [streaming.md](streaming.md) | Partial JSON parsing, rendering while text streams, validation and repair |
| [rendering.md](rendering.md) | Ink components, section layout, keys, the input race fix |
| [tools.md](tools.md) | WebSearch + Fetch: allow-list, slim schemas, turns with several rounds |
| [testing.md](testing.md) | The four test layers and the PTY harness |
| [findings.md](findings.md) | What the experiment measured and learned |
| [research-partial-updates.md](research-partial-updates.md) | Research (2026-11-20): partial UI updates, skeleton-first generation, prior art, a proposed design and an experiment plan |
| [changelog.md](changelog.md) | Changes to these docs |

## Rules for these docs

- One subject per page. Link to other pages; do not copy their text.
- Each claim about the code names its file (and its symbol, when that helps).
  When you change that code, update the page in the same commit.
- Put measured numbers (budgets, timings) here with the model and the date of
  the measurement.
- Record each docs change in [changelog.md](changelog.md).
