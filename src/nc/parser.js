/**
 * Turns one channel's NC program into a list of editable blocks.
 *
 * A block is an exact slice of the source text. Joining every block's `text`
 * in order gives back the original program byte for byte, so the editor can
 * move blocks around without ever rewriting the user's code.
 *
 * Block kinds
 *   toolpath    ordinary lines up to and including an ending N line ("N30")
 *   code        ordinary lines that are not (yet) closed by an N line, such as the
 *               part of a toolpath before a wait, headers, and loops kept together
 *   wait        a paired wait code matched by the wait pattern, e.g. M301P12
 *   macro-wait  an empty loop that waits for the other channel:
 *                 WHILE[#501NE20]DO1
 *                 END1
 *   signal      a shared macro assignment that releases the other channel: #501=20
 *
 * The parser is deliberately conservative: anything it does not fully
 * understand (complex loops, several waits on one line) stays in one block and
 * gets a review note, so a drag can never split code that must stay together.
 */
import { splitLines, withCommentsBlanked, firstComment, lineEnding, endsWithNewline } from './lines.js';
import { NUMBER_PATTERN, canonicalNumber } from './numbers.js';
import { DEFAULT_WAIT_PATTERN, validateWaitPattern } from './wait-pattern.js';
import { assignToolpaths } from './toolpaths.js';
import { TITLE_PROGRAM_HEADER, TITLE_PROGRAM_END, TITLE_COMMENTS, TITLE_LOOP_KEPT, TITLE_UNKNOWN_LOOP, TITLE_MULTIPLE_WAITS } from './titles.js';

/** WHILE[#501NE20]DO1 — only this exact "wait until #var equals value" form is movable. */
const MACRO_WAIT_LINE = new RegExp(`^\\s*WHILE\\s*\\[\\s*#(\\d+)\\s*NE\\s*(${NUMBER_PATTERN})\\s*\\]\\s*DO\\s*(\\d+)\\s*$`, 'i');
/** #501=20 on a line by itself. */
const SIGNAL_LINE = new RegExp(`^\\s*#(\\d+)\\s*=\\s*(${NUMBER_PATTERN})\\s*$`, 'i');
/** Any WHILE [...] DOn; group 1 is the loop number n. */
const LOOP_START = /\bWHILE\s*\[.*\]\s*DO\s*(\d+)\b/i;
/** ENDn; group 1 is the loop number n. */
const LOOP_END = /\bEND\s*(\d+)\b/i;
/** A line that ends a toolpath: starts with N followed by digits. */
const TOOLPATH_END_LINE = /^\s*N\s*(\d+)\b/i;
const PROGRAM_NUMBER_LINE = /^\s*O\s*\d+\s*$/i;
const PERCENT_LINE = /^\s*%\s*$/;
const PROGRAM_END_LINE = /^\s*M\s*0*(?:2|30)\s*$/i;
/** Wait matching is skipped on absurdly long lines to keep the editor responsive. */
const MAX_WAIT_SCAN_LENGTH = 2048;

/**
 * @typedef {object} Block
 * @property {string} id          Stable within one parse: `${channel}-${startLine}-${index}`.
 * @property {'toolpath'|'code'|'wait'|'macro-wait'|'signal'} kind
 * @property {string} text        Exact source slice, including line endings.
 * @property {number} startLine   1-based first line.
 * @property {number} endLine     1-based last line.
 * @property {string} title       Human-readable name shown in the editor.
 * @property {object|null} sync   Synchronization details for wait / macro-wait / signal blocks.
 * @property {{rotation: boolean, toolChange: boolean, g68: boolean}} flags
 * @property {string} [terminalN] For toolpaths: the ending N word, e.g. "N30".
 * @property {string} [comment]   First ( comment ) in the block.
 * @property {{n: string, label: string, part: number, parts: number}} [toolpath]
 *           Which toolpath this block belongs to (see toolpaths.js).
 */

/** Which machine features a piece of code touches; shown as small flags on the block. */
export function analyzeFlags(code) {
  return {
    rotation: /B\s*[+-]?(?:\d|\.|#|\[)/i.test(code),
    toolChange: /M\s*0*6(?![\d.])/i.test(code),
    g68: /G\s*0*68(?:\.\d+)?(?![\d.])/i.test(code),
  };
}

/**
 * Parse one channel program into blocks.
 *
 * @param {string} source            Full program text.
 * @param {object} [options]
 * @param {string} [options.waitPattern]          Regex source; see wait-pattern.js.
 * @param {'exact'|'ignore'} [options.waitParticipantMode]  Whether the P field must match too.
 * @param {'h'|'v'|string} [channel] Prefix for block ids.
 * @returns {{blocks: Block[], diagnostics: object[], eol: string, trailingNewline: boolean}}
 */
export function parseProgram(source, options = {}, channel = 'h') {
  if (typeof source !== 'string') throw new TypeError('Program source must be a string.');

  const lines = withCommentsBlanked(splitLines(source));
  const builder = new BlockBuilder(channel);

  const pattern = validateWaitPattern(options.waitPattern ?? DEFAULT_WAIT_PATTERN);
  const waitRegex = pattern.valid ? pattern.regex : null;
  if (!pattern.valid) builder.note('invalid-wait-pattern', pattern.error, 1, 'error');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const code = line.code;

    // --- Macro loops: WHILE ... DOn / ENDn -----------------------------------
    if (LOOP_START.test(code)) {
      index = readLoop(lines, index, builder); // returns the index of the loop's last line
      continue;
    }
    if (/\bWHILE\b/i.test(code)) {
      // A WHILE we cannot parse: keep everything from here on together rather than risk splitting it.
      builder.flushPending();
      builder.add(lines.slice(index), 'code', { title: TITLE_UNKNOWN_LOOP });
      builder.note('unsupported-loop', 'This WHILE form is not recognized. Its remaining source was kept together to avoid splitting a loop.', line.line);
      break;
    }
    if (LOOP_END.test(code)) builder.note('unmatched-loop-end', 'END has no recognized WHILE before it.', line.line);

    // --- Shared macro assignment: #501=20 ------------------------------------
    const signal = code.match(SIGNAL_LINE);
    if (signal) {
      builder.flushPending();
      builder.add([line], 'signal', { sync: macroSync(signal[1], signal[2], 'signal') });
      continue;
    }

    // --- Paired wait code: M301P12 -------------------------------------------
    if (readWaitLine(line, waitRegex, options, builder)) continue;

    // --- Program start / end markers: %, O1234, M30 --------------------------
    if (PROGRAM_NUMBER_LINE.test(code) || PERCENT_LINE.test(code) || PROGRAM_END_LINE.test(code)) {
      readProgramMarker(line, builder);
      continue;
    }

    // --- Ordinary code: collect until an N line closes the toolpath -----------
    builder.pending.push(line);
    const ending = code.match(TOOLPATH_END_LINE);
    if (ending) builder.flushPending('toolpath', { terminalN: `N${ending[1]}` });
  }

  builder.flushPending();
  assignToolpaths(builder.blocks);

  return {
    blocks: builder.blocks,
    diagnostics: builder.diagnostics,
    eol: lineEnding(source),
    trailingNewline: endsWithNewline(source),
  };
}

/** Collects blocks and review notes while the parser walks the lines. */
class BlockBuilder {
  constructor(channel) {
    this.channel = channel;
    this.blocks = [];
    this.diagnostics = [];
    /** Ordinary lines not yet closed by an N line. */
    this.pending = [];
  }

  /** Turn a run of lines into one block. */
  add(segment, kind = 'code', { sync = null, terminalN, title } = {}) {
    if (!segment.length) return;
    const code = segment.map((line) => line.code).join('\n');
    const block = {
      id: `${this.channel}-${segment[0].line}-${this.blocks.length}`,
      kind,
      text: segment.map((line) => line.raw).join(''),
      startLine: segment[0].line,
      endLine: segment[segment.length - 1].line,
      title: title || titleFor(segment, kind, sync, terminalN),
      sync,
      flags: analyzeFlags(code),
    };
    if (terminalN) block.terminalN = terminalN;
    const comment = firstComment(segment);
    if (comment) block.comment = comment;
    this.blocks.push(block);
  }

  /** Close the pending ordinary lines into a block (a toolpath when an N line ended them). */
  flushPending(kind = 'code', details = {}) {
    this.add(this.pending, kind, details);
    this.pending = [];
  }

  note(code, message, line, severity = 'warning') {
    this.diagnostics.push({ severity, code, message, line });
  }
}

/**
 * Read a WHILE loop starting at `start`. An empty `WHILE[#var NE value] DOn / ENDn`
 * becomes a movable macro-wait; any other loop is kept together as one block.
 * @returns {number} index of the loop's last line
 */
function readLoop(lines, start, builder) {
  builder.flushPending();
  const opening = lines[start].code.match(LOOP_START);
  const range = findLoopEnd(lines, start);
  const segment = lines.slice(start, range.end + 1);

  const exactWait = lines[start].code.match(MACRO_WAIT_LINE);
  const endsWithOwnEnd = new RegExp(`^\\s*END\\s*${opening[1]}\\s*$`, 'i').test(segment[segment.length - 1].code);
  const bodyIsEmpty = segment.slice(1, -1).every((entry) => !entry.code.trim());

  if (range.closed && !range.mismatch && segment.length >= 2 && exactWait && endsWithOwnEnd && bodyIsEmpty) {
    builder.add(segment, 'macro-wait', { sync: macroSync(exactWait[1], exactWait[2], 'wait') });
  } else {
    builder.add(segment, 'code', { title: TITLE_LOOP_KEPT });
    const [code, reason] = !range.closed
      ? ['unclosed-loop', 'This WHILE loop has no matching END; its remaining source was kept together.']
      : range.mismatch
        ? ['mismatched-loop', 'WHILE / END numbers do not match; this loop was kept together.']
        : !bodyIsEmpty
          ? ['unsupported-loop', 'This WHILE loop contains executable code. Its body and synchronization stay together.']
          : ['unsupported-loop', 'Only empty WHILE [#variable NE numeric-value] DO / END loops are recognized as movable waits.'];
    builder.note(code, reason, lines[start].line);
  }
  return range.end;
}

/**
 * Find the END that closes the WHILE at `start`, allowing nested loops.
 * @returns {{end: number, mismatch: boolean, closed: boolean}}
 */
function findLoopEnd(lines, start) {
  const open = []; // loop numbers still open, innermost last
  let mismatch = false;
  for (let index = start; index < lines.length; index += 1) {
    const opening = lines[index].code.match(LOOP_START);
    if (opening) open.push(opening[1]);
    const closing = lines[index].code.match(LOOP_END);
    if (!closing) continue;
    if (open[open.length - 1] !== closing[1]) mismatch = true;
    if (!open.length) return { end: index, mismatch: true, closed: false };
    open.pop();
    if (!open.length) return { end: index, mismatch, closed: true };
  }
  return { end: lines.length - 1, mismatch, closed: false };
}

/**
 * If the line holds a wait code, add it as a wait block.
 * @returns {boolean} true when the line was consumed
 */
function readWaitLine(line, waitRegex, options, builder) {
  if (!waitRegex) return false;
  const code = line.code;
  if (code.length > MAX_WAIT_SCAN_LENGTH) {
    builder.note('long-line', 'Wait matching was skipped on a line longer than 2,048 characters.', line.line);
    return false;
  }

  waitRegex.lastIndex = 0; // matchAll starts from lastIndex of a global regex
  const waits = [...code.matchAll(waitRegex)];
  if (!waits.length) return false;

  const [match] = waits;
  if (!match[1]) {
    builder.note('empty-wait-id', 'A wait-code match had an empty first capture and was kept as ordinary code.', line.line);
    return false; // treat as ordinary code
  }

  builder.flushPending();
  if (waits.length > 1) {
    builder.add([line], 'code', { title: TITLE_MULTIPLE_WAITS });
    builder.note('multiple-waits', 'This line contains multiple wait codes and cannot represent one alignment point. Put each wait on its own line.', line.line);
    return true;
  }

  const waitId = match[1];
  const participants = match[2] || undefined; // the P field, e.g. "12"
  const key = options.waitParticipantMode !== 'ignore' && participants ? `${waitId}P${participants}` : waitId;
  builder.add([line], 'wait', {
    sync: { kind: 'barrier', key, role: 'barrier', ...(participants ? { participants } : {}), code: match[0] },
  });

  const otherCode = `${code.slice(0, match.index)}${code.slice(match.index + match[0].length)}`.trim();
  if (otherCode) builder.note('combined-wait-line', 'This wait shares a line with other executable code; dragging moves the entire line.', line.line);
  return true;
}

/** %, O1234 and M30 lines become pinned "Program header" / "Program end" blocks. */
function readProgramMarker(line, builder) {
  const pendingIsOnlyComments = builder.pending.length && builder.pending.every((entry) => !entry.code.trim());
  if (pendingIsOnlyComments) {
    builder.flushPending('code', { title: builder.blocks.length ? TITLE_COMMENTS : TITLE_PROGRAM_HEADER });
  } else {
    builder.flushPending();
  }

  const isProgramEnd = PROGRAM_END_LINE.test(line.code);
  // A % after any toolpath is the closing tape mark, not the opening one.
  const isClosingPercent = PERCENT_LINE.test(line.code) && builder.blocks.some((block) => block.kind === 'toolpath');
  builder.add([line], 'code', { title: isProgramEnd || isClosingPercent ? TITLE_PROGRAM_END : TITLE_PROGRAM_HEADER });
}

/** Sync details for a macro signal or macro wait; numbers are canonical so 20 matches 20.0. */
function macroSync(variable, value, role) {
  variable = canonicalNumber(variable);
  value = canonicalNumber(value);
  return { kind: 'macro', key: `#${variable}=${value}`, role, variable, value };
}

function titleFor(lines, kind, sync, terminalN) {
  if (kind === 'wait') return `Wait ${sync.code.trim()}`;
  if (kind === 'macro-wait') return `Wait for #${sync.variable} = ${sync.value}`;
  if (kind === 'signal') return `Set #${sync.variable} = ${sync.value}`;

  const comment = firstComment(lines);
  if (kind === 'toolpath') return comment ? `${comment} · ${terminalN}` : `Toolpath ending ${terminalN}`;
  return comment || lines.find((line) => line.code.trim())?.code.trim().slice(0, 70) || TITLE_COMMENTS;
}
