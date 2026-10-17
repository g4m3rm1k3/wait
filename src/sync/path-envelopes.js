/** Commanded XYZ path bounds, preserving the actual NC operation order. */
import { splitLines, withCommentsBlanked } from '../nc/lines.js';
import { parseProgram } from '../nc/parser.js';
import { DEFAULT_WAIT_PATTERN, validateWaitPattern } from '../nc/wait-pattern.js';

const AXES = ['x', 'y', 'z'];
const WORD = /([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/gi;
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const SIGNAL = new RegExp(`^#\\d+\\s*=\\s*${NUMBER}$`, 'i');
const SAFE_WAIT_FILLER = new RegExp(`^(?:G0?4\\s*P\\s*${NUMBER}|M0?[345789])$`, 'i');
const KNOWN_G = new Set([0, 1, 4, 17, 18, 19, 20, 21, 40, 49, 54, 55, 56, 57, 58, 59, 61, 64, 80, 90, 91, 93, 94, 95, 96, 97, 98, 99]);
const KNOWN_M = new Set([2, 3, 4, 5, 6, 7, 8, 9, 30]);
const MAX_PAIRS = 10000;

/**
 * Bounds cover known commanded centerline sweeps, including rapid approach and
 * retract. They do not contain inferred machine/tool/holder geometry. A clear
 * result requires an explicit common-frame contract, known starting positions,
 * supported commands and a clearance covering BOTH tools/holders plus margin.
 */
export function analyzePathEnvelopes(sources, settings = {}) {
  const geometry = settings.pathGeometry ?? {};
  const clearance = typeof geometry.clearance === 'number' && Number.isFinite(geometry.clearance) && geometry.clearance >= 0
    ? geometry.clearance : null;
  const profile = { sharedFrame: geometry.sharedFrame === true, axis: geometry.sharedAxis === 'y' ? 'y' : 'xyz', clearance, initialPositions: geometry.initialPositions ?? {} };
  const pattern = validateWaitPattern(settings.waitPattern ?? DEFAULT_WAIT_PATTERN);
  const notes = [
    'Bounds describe commanded XYZ tool centerlines, including approach and retract; they are not a machine collision simulation.',
    'Configured clearance must cover both tools, tool lengths, holders and the required safety margin; different work offsets and B/G68 transforms need machine geometry.',
  ];
  const operations = { h: [], v: [] };
  let complete = true;
  for (const channel of ['h', 'v']) {
    const result = analyzeChannel(String(sources?.[channel] ?? ''), channel, settings, profile, pattern);
    operations[channel] = result.operations;
    notes.push(...result.notes);
    complete = complete && result.complete && result.operations.length > 0;
  }

  const conflicts = [];
  let truncated = false;
  for (const h of operations.h) {
    for (const v of operations.v) {
      if (conflicts.length >= MAX_PAIRS) { truncated = true; break; }
      const common = comparableFrame(h, v, profile);
      const reasons = [...new Set([...h.unresolved, ...v.unresolved])];
      let kind = 'unresolved';
      let clear = false;
      if (!common) reasons.unshift('The paths do not have a known matching coordinate frame.');
      else if (profile.axis === 'y' ? h.yRange && v.yRange : h.bounds && v.bounds) {
        const overlap = profile.axis === 'y'
          ? rangesIntersect(h.yRange, v.yRange, clearance ?? 0)
          : intersects(h.bounds, v.bounds, clearance ?? 0);
        if (overlap) {
          kind = 'possible-overlap';
          reasons.unshift(`Swept ${profile.axis === 'y' ? 'common Y intervals' : 'XYZ bounds'} overlap or are within the configured clearance.`);
        } else if (!reasons.length && clearance !== null) {
          kind = 'separated';
          clear = true;
        }
      }
      if (kind === 'unresolved') complete = false;
      conflicts.push({ hEvent: h.event, vEvent: v.event, hN: h.n, vN: v.n, axis: profile.axis, kind, clear, reasons });
    }
    if (truncated) break;
  }
  if (truncated) {
    notes.push(`Path comparison stopped after ${MAX_PAIRS.toLocaleString('en-US')} operation pairs; remaining pairs are unresolved.`);
    complete = false;
  }
  if (!operations.h.length || !operations.v.length) notes.push('Both channels need path operations before their envelopes can be compared.');
  return { operations, conflicts, notes, complete };
}

function analyzeChannel(source, channel, settings, profile, pattern) {
  const lines = withCommentsBlanked(splitLines(source));
  const initial = profile.initialPositions[channel] ?? {};
  const state = {
    position: Object.fromEntries(AXES.map((axis) => [axis, finite(initial[axis]) ? initial[axis] : null])),
    units: 1, absolute: true, unitsKnown: false, distanceKnown: false, motion: null, tool: null, b: null, workOffset: null,
    transformed: false, bUnknown: false, moved: false, ended: false, flowUnknown: false,
    radiusCompensation: false, lengthCompensation: false, unknownModal: false,
  };
  const ignoredWaitLines = new Set();
  for (const block of parseProgram(source, settings).blocks) {
    if (block.kind !== 'macro-wait') continue;
    const body = lines.slice(block.startLine, block.endLine - 1);
    // The editor parser permits plain motion in a wait body. Geometry must be
    // stricter: a loop containing motion cannot be treated as a stationary wait.
    if (!body.every((line) => !line.code.trim() || SAFE_WAIT_FILLER.test(line.code.trim()))) continue;
    for (let line = block.startLine; line <= block.endLine; line += 1) ignoredWaitLines.add(line);
  }

  const operations = [];
  const notes = [];
  let complete = true;
  let op = newOperation(1);
  const finish = (n, endLine) => {
    op.event = operations.length + 1;
    op.n = n;
    op.N = n;
    op.endLine = endLine;
    op.tool = state.tool;
    op.b = state.b;
    op.workOffset = op.offsets.size === 1 ? [...op.offsets][0] : op.offsets.size > 1 ? 'mixed' : state.workOffset;
    op.frame = op.frames.size === 1 ? [...op.frames][0] : op.frames.size > 1 ? 'mixed (unresolved)' : state.workOffset ?? (profile.sharedFrame || profile.axis === 'y' ? 'shared' : 'unknown');
    if (op.frames.size > 1 || op.offsets.size > 1) {
      op.invalidFrame = true;
      op.issues.add('This operation uses more than one coordinate frame.');
    }
    if (!profile.sharedFrame && profile.axis !== 'y') op.issues.add('A common spindle coordinate frame has not been confirmed.');
    if (profile.clearance === null) op.issues.add('Tool/holder envelope clearance has not been configured.');
    if (profile.axis === 'y' ? !op.yRange : !op.bounds) op.issues.add(`No complete ${profile.axis === 'y' ? 'Y interval' : 'XYZ path bounds'} are available for this operation.`);
    if (state.radiusCompensation || state.lengthCompensation) op.issues.add('Active tool radius/length compensation needs physical tool geometry.');
    if (state.unknownModal) op.issues.add('An unsupported modal cycle or coordinate transform remains unresolved.');
    if (state.flowUnknown) op.issues.add('Earlier unresolved control flow or a subprogram can change the executed path.');
    op.unresolved = [...op.issues];
    complete = complete && !op.unresolved.length;
    const { issues, frames, offsets, relevant, ...result } = op;
    operations.push(result);
    op = newOperation(endLine + 1);
  };

  for (const line of lines) {
    let code = line.code.trim().toUpperCase();
    if (!code || code === '%' || /^O\s*\d+$/.test(code)) continue;
    if (state.ended) {
      if (!/^N\s*\d+$/.test(code)) {
        notes.push(`${channel.toUpperCase()} line ${line.line}: executable source after M2/M30 was not analyzed.`);
        complete = false;
      }
      continue;
    }
    const ending = code.match(/^N\s*(\d+)\b/);
    if (ending) code = code.slice(ending[0].length).trim();
    const finishLine = () => { if (ending) finish(`N${ending[1]}`, line.line); };
    if (!code || ignoredWaitLines.has(line.line) || SIGNAL.test(code)) { finishLine(); continue; }
    if (code.length > 2048) {
      op.relevant = true;
      op.issues.add(`Line ${line.line}: geometry analysis was skipped on a line longer than 2,048 characters.`);
      state.flowUnknown = true;
      addSegment(op, state, line, state.position, unknownPosition(), 'unknown');
      state.position = unknownPosition();
      finishLine();
      continue;
    }
    if (pattern.valid) {
      pattern.regex.lastIndex = 0;
      code = code.replace(pattern.regex, (whole, id) => id ? ' '.repeat(whole.length) : whole).trim();
      if (!code) { finishLine(); continue; }
    }
    if (/#|\[|\]|\b(?:IF|WHILE|GOTO|DO\s*\d*|END\s*\d*)\b|^\//.test(code)) {
      op.relevant = true;
      op.issues.add(`Line ${line.line}: macro expressions, branches or loops leave the path unresolved.`);
      state.flowUnknown = true;
      addSegment(op, state, line, state.position, unknownPosition(), 'unknown');
      state.position = unknownPosition();
      finishLine();
      continue;
    }
    const words = [...code.matchAll(WORD)].map((match) => ({ letter: match[1], value: Number(match[2]) }));
    if (!words.length || code.replace(WORD, '').trim() || words.some((word) => !finite(word.value))) {
      op.relevant = true;
      op.issues.add(`Line ${line.line}: unrecognized NC syntax leaves the path unresolved.`);
      addSegment(op, state, line, state.position, unknownPosition(), 'unknown');
      state.position = unknownPosition();
      state.flowUnknown = true;
      finishLine();
      continue;
    }
    const gs = words.filter((word) => word.letter === 'G').map((word) => word.value);
    const ms = words.filter((word) => word.letter === 'M').map((word) => word.value);
    // Program-end instructions alone are a footer, not an extra machining op.
    if (!words.every((word) => word.letter === 'M' && (word.value === 2 || word.value === 30))) op.relevant = true;
    if (state.radiusCompensation || state.lengthCompensation) op.issues.add('Active or cancelling tool radius/length compensation needs physical tool geometry.');
    if (gs.includes(20)) { state.units = 25.4; state.unitsKnown = true; }
    if (gs.includes(21)) { state.units = 1; state.unitsKnown = true; }
    if (gs.includes(90)) { state.absolute = true; state.distanceKnown = true; }
    if (gs.includes(91)) { state.absolute = false; state.distanceKnown = true; }
    for (const g of gs) {
      if ([0, 1, 2, 3].includes(g)) state.motion = g;
      if (g === 40) {
        if (state.radiusCompensation) state.position = unknownPosition();
        state.radiusCompensation = false;
      }
      if (g === 49) {
        if (state.lengthCompensation) state.position = unknownPosition();
        state.lengthCompensation = false;
      }
      if (g === 41 || g === 42) state.radiusCompensation = true;
      if (g === 43 || g === 44) state.lengthCompensation = true;
      if (g >= 54 && g <= 59 && Number.isInteger(g)) {
        const offset = `G${g}`;
        if (state.workOffset !== offset && (state.workOffset !== null || state.moved)) {
          op.issues.add(`Line ${line.line}: the work-offset change has no known coordinate transform.`);
          state.position = unknownPosition();
        }
        state.workOffset = offset;
      }
      if (g === 68 || g === 69) {
        state.transformed = g === 68;
        state.position = unknownPosition();
        op.invalidFrame = true;
        op.issues.add(`Line ${line.line}: G${g} coordinate transformation is not modeled.`);
      }
    }
    if (state.radiusCompensation || state.lengthCompensation) op.issues.add('Active tool radius/length compensation needs physical tool geometry.');
    const t = words.filter((word) => word.letter === 'T').at(-1);
    if (t) {
      state.tool = t.value;
      if (!op.tools.includes(t.value)) op.tools.push(t.value);
      op.issues.add(`Line ${line.line}: tool-change travel is not specified by the XYZ path.`);
    }
    const b = words.filter((word) => word.letter === 'B').at(-1);
    if (b) {
      state.b = state.absolute ? b.value : state.b === null ? null : state.b + b.value;
      state.bUnknown = true;
    }
    if (state.bUnknown || state.transformed || gs.includes(53)) {
      op.invalidFrame = true;
      op.issues.add('B-axis, G53 or active G68 positions require a machine coordinate transform.');
    }
    const unsupportedG = gs.filter((g) => !KNOWN_G.has(g));
    const unsupportedM = ms.filter((m) => !KNOWN_M.has(m));
    if (unsupportedG.length) op.issues.add(`Line ${line.line}: ${unsupportedG.map((g) => `G${g}`).join(', ')} sweep/transform is not modeled.`);
    if (unsupportedG.some((g) => ![2, 3, 41, 42, 43, 44, 53, 68, 69].includes(g))) state.unknownModal = true;
    if (state.unknownModal) op.issues.add('An unsupported modal cycle or coordinate transform remains unresolved.');
    if (unsupportedM.length) {
      op.issues.add(`Line ${line.line}: ${unsupportedM.map((m) => `M${m}`).join(', ')} may move the tool or execute a subprogram.`);
      state.flowUnknown = true;
    }
    if (gs.some((g) => g === 41 || g === 42 || g === 43 || g === 44)) {
      op.issues.add('Tool radius/length compensation needs physical tool geometry.');
    }
    if (words.some((word) => !'GMXYZBFSHTDPLQRIJK'.includes(word.letter))) {
      op.issues.add(`Line ${line.line}: additional axes or address words are not modeled.`);
      state.flowUnknown = true;
    }
    const axes = words.filter((word) => 'XYZ'.includes(word.letter));
    if (axes.length) {
      const modesKnown = state.unitsKnown && state.distanceKnown;
      if (!modesKnown) op.issues.add(`Line ${line.line}: set G20/G21 units and G90/G91 distance mode explicitly before motion.`);
      if (axes.some((word, index) => axes.findIndex((other) => other.letter === word.letter) !== index)) {
        op.issues.add(`Line ${line.line}: repeated axis words are not modeled.`);
        addSegment(op, state, line, state.position, unknownPosition(), 'unknown');
        state.position = unknownPosition();
      } else {
        const previous = { ...state.position };
        const next = { ...previous };
        for (const axis of axes) {
          const key = axis.letter.toLowerCase();
          const value = axis.value * state.units;
          next[key] = state.absolute ? value : previous[key] === null ? null : previous[key] + value;
          if (!finite(next[key])) next[key] = null;
        }
        if (profile.axis === 'y' ? !finite(previous.y) : !knownPosition(previous)) op.issues.add(`Line ${line.line}: the starting ${profile.axis === 'y' ? 'Y' : 'tool'} position is unknown; the complete approach sweep cannot be bounded.`);
        if (state.motion !== 0 && state.motion !== 1) op.issues.add(`Line ${line.line}: arc/cycle or unknown modal motion has an unresolved sweep.`);
        includePoint(op, previous);
        includePoint(op, next);
        const supportedSweep = !unsupportedG.length && !unsupportedM.length && !state.unknownModal && !state.transformed && !state.bUnknown && !state.radiusCompensation && !state.lengthCompensation;
        addSegment(op, state, line, previous, next, modesKnown && supportedSweep && state.motion === 0 ? 'rapid' : modesKnown && supportedSweep && state.motion === 1 ? 'feed' : 'unknown');
        op.frames.add(state.workOffset ?? (profile.sharedFrame || profile.axis === 'y' ? 'shared' : 'unknown'));
        op.offsets.add(state.workOffset);
        state.position = modesKnown ? next : unknownPosition();
        state.moved = true;
      }
    } else if (gs.some((g) => g === 2 || g === 3) && words.some((word) => 'IJKR'.includes(word.letter))) {
      op.issues.add(`Line ${line.line}: a full-circle arc has an unresolved sweep.`);
      addSegment(op, state, line, state.position, state.position, 'unknown');
    } else if (b || unsupportedG.length || unsupportedM.length) {
      addSegment(op, state, line, state.position, unknownPosition(), 'unknown');
    }
    // Calls, cycles and frame changes may move axes not written on the line.
    if (unsupportedG.some((g) => ![2, 3, 43, 44].includes(g)) || unsupportedM.length || gs.includes(53)) state.position = unknownPosition();
    if (ms.includes(2) || ms.includes(30)) state.ended = true;
    finishLine();
  }
  if (op.relevant || op.bounds) finish(null, lines.length);
  return { operations, notes, complete };
}

function newOperation(startLine) {
  return { event: null, n: null, N: null, tool: null, tools: [], b: null, bounds: null, yRange: null, segments: [], frame: 'unknown', workOffset: null, unresolved: [], startLine, endLine: startLine, invalidFrame: false, issues: new Set(), frames: new Set(), offsets: new Set(), relevant: false };
}
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function unknownPosition() { return { x: null, y: null, z: null }; }
function knownPosition(position) { return AXES.every((axis) => finite(position[axis])); }
function includePoint(op, position) {
  if (finite(position.y)) {
    if (!op.yRange) op.yRange = [position.y, position.y];
    else { op.yRange[0] = Math.min(op.yRange[0], position.y); op.yRange[1] = Math.max(op.yRange[1], position.y); }
  }
  if (!knownPosition(position)) return;
  if (!op.bounds) op.bounds = Object.fromEntries(AXES.map((axis) => [axis, [position[axis], position[axis]]]));
  else for (const axis of AXES) {
    op.bounds[axis][0] = Math.min(op.bounds[axis][0], position[axis]);
    op.bounds[axis][1] = Math.max(op.bounds[axis][1], position[axis]);
  }
}
function comparableFrame(h, v, profile) {
  if (h.invalidFrame || v.invalidFrame || h.frame !== v.frame || h.frame === 'unknown' || h.frame.startsWith('mixed')) return false;
  if (h.workOffset || v.workOffset) return h.workOffset === v.workOffset;
  return (profile.sharedFrame || profile.axis === 'y') && h.frame === 'shared';
}
function intersects(a, b, clearance) {
  return AXES.every((axis) => rangesIntersect(a[axis], b[axis], clearance));
}
function rangesIntersect(a, b, clearance) { return a[1] + clearance >= b[0] && b[1] + clearance >= a[0]; }
function addSegment(op, state, line, start, end, motion) {
  op.segments.push({ line: line.line, motion, start: { ...start }, end: { ...end }, tool: state.tool, workOffset: state.workOffset, b: state.b, source: line.content });
}
