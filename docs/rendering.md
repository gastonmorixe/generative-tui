# Rendering

Sources: `src/render.tsx` (blocks and layout) and `src/app.tsx` (shell and
keys). Stack: Ink 6 and React 19.

## Rule: read loosely

The **same components** draw the partial screens and the validated screen. So
no component trusts the zod type. They use small coercers: `str`, `num`,
`arr`, and `obj` give a default for a missing or wrong field. Strings are
clipped with `…` to fit the width.

## Tones → colors

| Tone | Ink color |
| --- | --- |
| normal | (default) |
| muted | gray |
| info | cyan |
| success | green |
| warning | yellow |
| error | red |
| accent | magenta |

## Section layout (`packRows`)

Sections are packed into rows from left to right:

- `full` always starts a new row and fills it.
- Consecutive `half` / `third` sections share a row while their fractions add
  up to ≤ 1.
- A section that would be narrower than `MIN_SECTION_COLS = 34` columns counts
  as full. So a narrow terminal stacks the sections.
- In a row, each section gets `floor((width - gaps) / n)` columns, with a gap
  of 1 column.

The total width is `max(40, stdout.columns - 2)`.

## Shell (`App`)

From top to bottom: a header (model, tools, turns, time), the sections (or the
raw JSON with `^O`), the tool log for the current turn, the action bar, the
prompt line, and the status line.

State (`State` in `app.tsx`):

- `view`: what is drawn now. It is the partial screen while the text streams,
  and then the validated screen.
- `screen`: the **last valid** screen. When a turn fails, the app shows the
  error, and the old screen's actions stay usable.
- `phase`: `idle`, `streaming`, or `error`.

## Keys

| Key | When | Effect |
| --- | --- | --- |
| text + Enter | any time it is not busy | send a free prompt |
| `1`–`6` | the prompt line is empty | run that action at once |
| Tab / → / ← | the prompt line is empty | move the action selection |
| Enter | the prompt line is empty | run the selected action |
| `^O` | always | switch the raw JSON view on and off |
| Esc | streaming | stop the turn (`AbortController` + `agent.abort()`) |
| Esc | idle | clear the prompt line |
| `^C` | always | stop the turn, close the agent, exit |

## The stale input handler (fixed)

Ink subscribes `useInput` again in a **passive** effect, and that effect runs
*after* the frame is drawn. A key that arrived between the draw and the effect
went to the previous handler, with old state. For example, "1" was typed into
the prompt instead of running action 1, because the old handler had no
actions yet.

The fix: the handler reads `actions`, `busy`, `input`, and `selected` from a
ref (`live`). A `useLayoutEffect` updates the ref when React commits, before
that gap. The in-process tests found this bug. After the fix, 210 of 210
reruns passed.
