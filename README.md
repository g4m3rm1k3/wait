# Spindle Sync

A local, browser based NC editor for two linked channels of a four-channel machine. The initial profile is labeled Fanuc 30i-B. Wait syntax and pairing are configurable; the profile does not assume universal Fanuc or machine-builder synchronization semantics.

## Open

Open the hosted copy at <https://g4m3rm1k3.github.io/wait/>, or serve this folder with any static server (for example VS Code Live Server) and open `index.html`. Opening the file directly with `file://` does not work because browsers block ES modules there. With Node.js 20+, you can also double-click **Start Spindle Sync.cmd** on Windows or run `npm start` and open <http://127.0.0.1:4173>. There are no packages to install, remote libraries, external fonts, or program uploads. The server binds to loopback only.

## Arrange programs

1. Import two ASCII / UTF-8 NC files or paste your programs.
2. In Settings, choose the horizontal and vertical channels (1–4), wait-code regex, P-field matching, and insertion template. The default example pattern is `\bM(3\d{2})\s*P(\d+)\b`. The first capture is the wait ID and the optional second capture is the P field. Choose exact P matching or ignore P according to your machine's actual wait semantics. Matching repeated wait IDs uses occurrence order.
3. Each toolpath includes all ordinary lines through its **ending N line**. Recognized wait lines, literal shared-macro assignments, and empty `WHILE[#501NE123]DO1` / `END1` loops are separately movable. Complex loops stay together and get a review note. A wait inside a toolpath splits the surrounding source into editable fragments rather than moving noncontiguous source together.
4. Drag a dotted handle within its original channel, use the block arrows, or select it and press Alt+Up / Alt+Down. Program boundaries are pinned. Visual spacers align paired waits and unambiguous macro signals without changing either program's source order.
5. Edit code in place; it regroups when you leave the text block. Source view exposes the full programs. Apply edits or switch back to Aligned editor to apply pending source changes. Ctrl+S and Export also apply source drafts.
6. Add sync inserts a paired wait or one-way shared-macro release using your template. Insertion happens after the selected block and before the other program's end; drag the blocks into the intended positions. No B clearance, safe angle, G68 code, or tool-change sequence is automatically generated.
7. Undo / redo preserve complete program text, settings and duration overrides. Ctrl+Z outside a text field undoes workspace changes; text fields retain native text undo.

## Time and utilization

Settings provide a fallback cutting feed, rapid feed (mm/min), B-axis rate (degrees/min), and seconds per tool change (any T word, e.g. `T5`; M6 is not treated as a tool change). Programmed F values can be used or replaced with the fallback feed. G20/G21 and G90/G91 are modeled for straight XYZ moves. XYZ and B motion on the same line use the longer estimated travel time. Initial X/Y/Z/B are assumed zero and called out in the notes.

Each channel's bar shows feed motion (cut estimate), rapid/B travel (air estimate), tool changes, and synchronization waiting. Waiting includes idle after a channel has finished. Percentages use commanded feed-motion time divided by the shared estimated cycle time. **At least one cutting** measures the union of both channels' feed-motion intervals, so overlapping cuts are counted once; its complement shows time with neither channel cutting.

The event scheduler handles barriers and shared macro values independently. An assignment does not hold its producing channel. A macro equality wait sees the current shared value when reached, rather than any past assignment. Missing partners, crossed barrier order, stalled waits, ambiguous repeated assignments, and possible overwrites are reported. Optional initial macro values can be entered in Settings; unspecified values start unknown.

Select an operation, enter a duration in seconds, and click **Apply duration** (or press Enter) to use a measured time. This replaces the whole block estimate and categorizes it by the dominant operation. Synchronization delays are calculated by the schedule and cannot be manually overridden. If you need separate cut/air/tool timing, split the source into separate N-ended operations.

Arcs, canned cycles, subprograms, branches, coordinate transforms such as G68/G69, macro expressions, and unrecognized instructions require manual operation times or the existing machine simulator. Unknown durations make the schedule **partial**; the displayed time is not a guaranteed lower bound. Reordering operations can also change modal state, tool selection and starting coordinates. A measured override supplies time; it does not validate program semantics. M2/M30 stop a channel; executable text after program end is diagnosed and omitted from the schedule.

This version edits and schedules the selected pair only. It does not simulate all four channels, stock contact, spindle geometry, kinematics, acceleration, collisions, B-axis safe positions, or G68 correctness. Keep the existing machine simulation in the verification workflow.

## Save

The current workspace autosaves to this browser and origin. Export a **workspace JSON** for a portable backup including both programs, profile, and manual times. Restore it from the Export dialog. NC downloads contain only channel text; alignment spacers never enter the output. Untouched imported ASCII / UTF-8 text preserves original whitespace and line endings, including a missing final newline. Editing a span uses that span's first detected newline style. Reordering inserts a minimal separator if an unterminated line would otherwise merge with another instruction.

## Development

There is no build step: the browser loads the files in `src/` directly, so any static server (Live Server, GitHub Pages) works.

```
index.html          page structure
src/main.js         entry point; wires the UI modules together
src/nc/             reading NC text: lines, numbers, wait pattern, parser, toolpath grouping, edits
src/sync/           lining channels up at waits; crossed waits, macro races, deadlock detection
src/timing/         cycle estimate: G-code -> timed actions -> two-channel schedule -> totals
src/ui/             on-screen behaviour; app.js is the controller, workspace.js holds the data
src/ui/dialogs/     Settings, Import, Add sync, Export
src/styles/         CSS, one file per screen area
tests/              node --test suites for nc, sync and timing
```

`npm test` runs the tests (Node.js 20+). `npm run check` checks JavaScript syntax.
