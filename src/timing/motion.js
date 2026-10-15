/**
 * Reads one channel's blocks and turns them into a list of timed actions.
 *
 * Action kinds (all carry `blockId`):
 *   { kind: 'time', type: 'cut'|'air'|'toolChange'|'unknown', duration }  seconds of work
 *   { kind: 'barrier', key, occurrence }      paired wait; both channels must arrive
 *   { kind: 'set', variable, value }          shared macro assignment (does not stop)
 *   { kind: 'macroWait', variable, value }    wait until the variable has the value
 *   { kind: 'unknownWait', variable, value }  a wait whose value cannot be modeled
 *
 * Time model (deliberately simple):
 *   - straight G0 / G1 moves only; distance / feed rate
 *   - G0 uses the rapid rate, G1 the programmed F (or the fallback cut feed)
 *   - B rotation uses the B-axis rate; a move with both XYZ and B takes the longer
 *   - M6 takes the configured tool-change time
 *   - G20/G21 units and G90/G91 absolute/incremental are followed
 * Anything else (arcs, canned cycles, G68, macros, subprograms) becomes an
 * 'unknown' action: the user must enter a manual time for that block.
 */
import { executableLines } from '../nc/lines.js';
import { NUMBER_PATTERN } from '../nc/numbers.js';
import { macroNumber, variableKey } from './macro-values.js';

export const EPSILON = 1e-9;

const SIMPLE_ASSIGNMENT = new RegExp(`^#(\\d+)\\s*=\\s*(${NUMBER_PATTERN})$`, 'i');
const SIMPLE_WAIT = new RegExp(`^WHILE\\s*\\[\\s*#(\\d+)\\s*NE\\s*(${NUMBER_PATTERN})\\s*\\]\\s*DO(\\d+)\\s+END\\3$`, 'i');
const WORD = /([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g;
const CONTROL_FLOW = /\b(?:IF|WHILE|GOTO|DO\d*|END\d*)\b|#|\[|\]|^\//;

/** G codes the straight-line model understands (or can safely ignore). */
const KNOWN_G = new Set([0, 1, 2, 3, 17, 18, 19, 20, 21, 40, 43, 49, 54, 55, 56, 57, 58, 59, 61, 64, 80, 90, 91, 93, 94, 95, 96, 97, 98, 99]);
/** M codes that take no modeled time: spindle, coolant, program end. */
const TIMELESS_M = new Set([2, 3, 4, 5, 8, 9, 30]);
const SUPPORTED_LETTERS = 'GMXYZBFSHTDPLQRIJK';

/**
 * Interprets the blocks of one channel in program order, keeping modal state
 * (units, absolute mode, feed, current position) from block to block.
 */
export class ChannelInterpreter {
  /**
   * @param {'h'|'v'} channel
   * @param {object} settings  normalized timing settings (see estimate.js)
   * @param {import('./report.js').TimingReport} report
   */
  constructor(channel, settings, report) {
    this.channel = channel;
    this.settings = settings;
    this.report = report;
    this.modal = {
      units: 1, // mm per program unit: 1 for G21, 25.4 for G20
      absolute: true, // G90 / G91
      motion: null, // last G0/G1/G2/G3
      feed: null, // last F word
      feedMode: 94, // G93 / G94 / G95
      position: { X: 0, Y: 0, Z: 0, B: 0 }, // null = unknown after an unmodeled move
    };
    this.barrierCount = new Map(); // wait key -> how many times seen so far
    this.originNoticeGiven = false;
    this.programEnded = false; // M2 / M30 reached
  }

  /**
   * Read one block.
   * @returns {{actions: object[], unknownMessages: string[], cleanText: string, isSimpleWait: boolean, afterEnd: boolean}}
   */
  readBlock(block, id) {
    const ctx = new BlockActions(id);
    const cleanLines = executableLines(block.text ?? block.source ?? '');
    const cleanText = cleanLines.filter(Boolean).join('\n');

    if (this.programEnded) {
      if (hasExecutableCode(cleanLines) || block.sync) this.ignoredAfterEnd(id);
      return { actions: [], unknownMessages: [], cleanText, isSimpleWait: false, afterEnd: true };
    }

    const simpleWait = SIMPLE_WAIT.exec(cleanText);
    if (block.sync) {
      this.readSync(block.sync, ctx);
      if (block.sync.kind === 'barrier' && block.sync.code) {
        const otherCode = cleanText.replace(String(block.sync.code).toUpperCase(), '').replace(/^N\d+\s*/, '').trim();
        if (otherCode) ctx.unknown('This barrier shares a line with executable code; its motion and execution order require separate lines before they can be timed.');
      }
      const mCodes = [...cleanText.matchAll(/M\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g)].map((match) => Number(match[1]));
      if (mCodes.some((code) => code === 2 || code === 30)) this.programEnded = true;
    } else if (simpleWait) {
      this.readSync({ kind: 'macro', role: 'wait', variable: simpleWait[1], value: simpleWait[2] }, ctx);
    } else {
      for (const line of cleanLines) this.readLine(line, ctx, id);
    }

    return { actions: ctx.actions, unknownMessages: ctx.unknownMessages, cleanText, isSimpleWait: !!simpleWait, afterEnd: false };
  }

  /** Turn a block's sync details into a barrier / set / macroWait action. */
  readSync(sync, ctx) {
    if (sync.kind === 'barrier' || sync.role === 'barrier') {
      const key = String(sync.key);
      const occurrence = (this.barrierCount.get(key) ?? 0) + 1;
      this.barrierCount.set(key, occurrence);
      ctx.push({ kind: 'barrier', key, occurrence });
      return;
    }

    const variable = variableKey(sync.variable);
    const value = macroNumber(sync.value);
    if (!/^\d+$/.test(variable) || value === undefined) {
      ctx.unknown('Macro synchronization requires a finite literal within the estimator precision bounds: safe integers, or decimals with at most 15 significant digits.');
      if (sync.role !== 'signal') ctx.push({ kind: 'unknownWait', variable, value: String(sync.value) });
      return;
    }
    ctx.push({ kind: sync.role === 'signal' ? 'set' : 'macroWait', variable, value });
  }

  /** Interpret one comment-free, upper-case line. */
  readLine(rawLine, ctx, id) {
    const line = rawLine.replace(/^\s*N\d+\s*/, '').trim();
    if (!line || line === '%' || /^O\d+$/.test(line)) return;
    if (this.programEnded) {
      this.ignoredAfterEnd(id);
      return;
    }

    const assignment = SIMPLE_ASSIGNMENT.exec(line);
    if (assignment) {
      this.readSync({ kind: 'macro', role: 'signal', variable: assignment[1], value: assignment[2] }, ctx);
      return;
    }
    if (CONTROL_FLOW.test(line)) {
      ctx.unknown(`Control flow, macro expressions, or optional execution cannot be timed automatically: ${line}`);
      return;
    }

    // Split into address words: "G1 X10 F500" -> G1, X10, F500.
    const words = [...line.matchAll(WORD)].map((match) => ({ letter: match[1], value: Number(match[2]), text: match[0] }));
    const leftover = line.replace(WORD, '').replace(/\s/g, '');
    if (leftover || !words.length) {
      ctx.unknown(`Unrecognized instruction cannot be timed automatically: ${line}`);
      return;
    }
    if (words.some((word) => !Number.isFinite(word.value))) {
      ctx.unknown('An instruction contains a number outside the supported numeric range.');
      return;
    }

    const gCodes = words.filter((word) => word.letter === 'G').map((word) => word.value);
    const mCodes = words.filter((word) => word.letter === 'M').map((word) => word.value);
    if (mCodes.some((code) => code === 2 || code === 30)) this.programEnded = true;
    this.updateModalState(gCodes, words);

    for (const code of mCodes) {
      if (code === 6) ctx.time(this.settings.toolChangeSeconds, 'toolChange', 'Tool change');
      else if (!TIMELESS_M.has(code)) ctx.unknown(`M${code} has no configured time or execution model.`);
    }

    const unknownG = gCodes.filter((code) => !KNOWN_G.has(code));
    if (unknownG.length) {
      ctx.unknown(`${unknownG.map((code) => `G${code}`).join(', ')} is not included in the straight-line timing model.`);
      // An unmodeled move or frame change (e.g. G68) also makes the next starting position unknown.
      if (unknownG.some((code) => code !== 4)) {
        const onlyRotationFrame = unknownG.every((code) => code === 68 || code === 69);
        for (const axis of onlyRotationFrame ? ['X', 'Y', 'Z'] : ['X', 'Y', 'Z', 'B']) this.modal.position[axis] = null;
      }
      return;
    }
    if (words.some((word) => !SUPPORTED_LETTERS.includes(word.letter))) ctx.unknown(`An unsupported axis or word appears in: ${line}`);

    const axes = words.filter((word) => 'XYZB'.includes(word.letter));
    if (!axes.length) {
      const isArc = this.modal.motion === 2 || this.modal.motion === 3;
      if (isArc && words.some((word) => 'IJKR'.includes(word.letter))) ctx.unknown('Arc motion (including full circles) requires a manual block time.');
      return;
    }
    this.readMove(axes, ctx, id);
  }

  updateModalState(gCodes, words) {
    const modal = this.modal;
    if (gCodes.includes(20)) modal.units = 25.4;
    if (gCodes.includes(21)) modal.units = 1;
    if (gCodes.includes(90)) modal.absolute = true;
    if (gCodes.includes(91)) modal.absolute = false;
    for (const feedMode of [93, 94, 95]) if (gCodes.includes(feedMode)) modal.feedMode = feedMode;
    for (const word of words) if (word.letter === 'F') modal.feed = word.value;
    for (const code of gCodes) if ([0, 1, 2, 3].includes(code)) modal.motion = code;
  }

  /** Time a straight move from the current position to the axis words. */
  readMove(axes, ctx, id) {
    const modal = this.modal;
    const next = { ...modal.position };
    let xyzSquared = 0;
    let rotation = 0;
    let unknownStart = false;

    for (const { letter: axis, value } of axes) {
      const coordinate = value * (axis === 'B' ? 1 : modal.units); // B is degrees, never scaled
      const from = modal.position[axis];
      const to = modal.absolute ? coordinate : from === null ? null : from + coordinate;
      next[axis] = to;
      if (from === null || to === null) unknownStart = true;
      else if (axis === 'B') rotation = Math.abs(to - from);
      else xyzSquared += (to - from) ** 2;
    }
    modal.position = next;

    if (!this.originNoticeGiven) {
      const name = this.channel === 'h' ? 'Horizontal' : 'Vertical';
      this.report.warn('initial-position-assumed', `${name} motion starts from assumed X0 Y0 Z0 B0; enter manual block times where the actual starting position differs.`, [id], 'info');
      this.originNoticeGiven = true;
    }

    if (axes.some((word, index) => axes.findIndex((other) => other.letter === word.letter) !== index)) return ctx.unknown('Repeated axis words on one line are not modeled.');
    if (unknownStart) return ctx.unknown('Travel begins at an unknown position after an unmodeled instruction.');
    if (modal.motion === 2 || modal.motion === 3) return ctx.unknown('Arc motion (including modal G2/G3) requires a manual block time.');
    if (modal.motion === null) return ctx.unknown('Axis words have no known G0/G1 motion mode.');
    if (modal.motion === 1 && modal.feedMode !== 94) return ctx.unknown(`G${modal.feedMode} feed timing requires a manual block time.`);

    const distance = Math.sqrt(xyzSquared);
    const settings = this.settings;
    const feed = modal.motion === 0
      ? settings.rapidFeed
      : settings.useProgramFeed && modal.feed !== null
        ? modal.feed * modal.units
        : settings.cutFeed;
    if (!(feed > 0)) return ctx.unknown('A positive feed rate is required to estimate this move.');

    // Feeds are per minute; XYZ and B move together, so the slower one sets the time.
    const seconds = Math.max(distance / feed, rotation / settings.rotationFeed) * 60;
    const type = modal.motion === 1 && distance > EPSILON ? 'cut' : 'air';
    ctx.time(seconds, type, rotation > 0 ? 'Move with B-axis rotation' : undefined);
  }

  ignoredAfterEnd(id) {
    this.report.markIncomplete();
    this.report.warn('after-program-end', 'Executable code after M2/M30 is ignored by this channel estimate. Move intended operations before the program end.', [id]);
  }
}

/** Accumulates the actions of one block. */
class BlockActions {
  constructor(blockId) {
    this.blockId = blockId;
    this.actions = [];
    this.unknownMessages = [];
  }

  push(action) {
    this.actions.push({ ...action, blockId: this.blockId });
  }

  /** Work that takes time; zero-length work is dropped. */
  time(duration, type, label) {
    if (!Number.isFinite(duration)) return this.unknown('Travel duration exceeds the numeric range of the estimate.');
    if (duration > EPSILON) this.actions.push({ kind: 'time', duration, type, blockId: this.blockId, ...(label ? { label } : {}) });
  }

  /** Work whose time cannot be modeled; the block will need a manual time. */
  unknown(message) {
    this.unknownMessages.push(message);
    this.actions.push({ kind: 'time', type: 'unknown', duration: 0, blockId: this.blockId, label: message });
  }
}

/** Anything other than N numbers, % and O numbers counts as executable. */
function hasExecutableCode(lines) {
  return lines.some((raw) => {
    const line = raw.replace(/^\s*N\d+\s*/, '').trim();
    return line && line !== '%' && !/^O\s*\d+$/.test(line);
  });
}
