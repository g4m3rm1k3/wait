/**
 * Ordered wait placement. No operation is moved, paired by its duration, or
 * inferred to be clear from a coordinate system or a tool number.
 *
 * Safety metadata is an assertion supplied by the NC author:
 *   H: (SYNC WINDOW OPEN envelope) ... (SYNC WINDOW CLOSE)
 *   V: (SYNC ENVELOPE other-envelope) ... (SYNC CLEAR) N...
 *   H: ... (SYNC CLEAR) N... permits a sequential release at that boundary.
 * These assertions do not constitute a machine collision simulation.
 */
import { parseProgram, analyzeFlags } from '../nc/parser.js';
import { splitLines, withCommentsBlanked, lineEnding } from '../nc/lines.js';
import { DEFAULT_WAIT_PATTERN, validateWaitPattern } from '../nc/wait-pattern.js';
import { estimateCycle } from '../timing/estimate.js';
import { readOverride } from '../timing/overrides.js';
import { clearWaitCodes, AUTO_WAIT_MARKER } from './wait-codes.js';
import { analyzePathEnvelopes } from './path-envelopes.js';

const CHANNELS = ['h', 'v'];
const END = /^\s*M\s*0*(?:2|30)\s*$/i;
const HEADER = /^\s*(?:%|O\s*\d+)\s*$/i;
const N_END = /^\s*N\s*\d+\b/i;
const CONTROL = /#|\[|\]|\b(?:IF|WHILE|GOTO|DO\s*\d+|END\s*\d*)|^\s*\/|M\s*0*(?:0|1|98|99)(?![\d.])/i;
const BT_WORD = /[BT]\s*[+-]?(?:\d|\.)/i;
const MARKER = /^\s*\(\s*SYNC\s+(WINDOW\s+OPEN\s+([A-Z0-9_.-]+)|WINDOW\s+CLOSE|ENVELOPE\s+([A-Z0-9_.-]+)|CLEAR)\s*\)\s*$/i;

/** Pure preview. An error always leaves `sources` equal to the supplied input. */
export function planWaitCodes(sources, settings = {}, overrides = {}, options = {}) {
  const original = { h: sources?.h, v: sources?.v };
  const result = {
    sources: { ...original }, errors: [], notes: [], rows: [], annotations: [],
    timing: null, beforeTiming: null, longerChannel: null, waitCount: 0,
    overrides: { ...overrides }, blockIdentities: { h: [], v: [] },
    pathAnalysis: null, pathGeometry: structuredClone(options.pathGeometry ?? settings.pathGeometry ?? null),
  };
  if (CHANNELS.some((channel) => typeof original[channel] !== 'string')) {
    result.errors.push('Load an NC program for both H and V before planning waits.');
    return result;
  }
  const pattern = validateWaitPattern(settings.waitPattern ?? DEFAULT_WAIT_PATTERN);
  if (!pattern.valid) {
    result.errors.push(pattern.error);
    return result;
  }
  const originalBlocks = options.blocks ?? parseBoth(original, settings);
  result.beforeTiming = estimateCycle(originalBlocks.h, originalBlocks.v, settings, overrides);
  const clean = {};
  for (const channel of CHANNELS) {
    clean[channel] = options.replaceGenerated === false ? original[channel]
      : clearWaitCodes(original[channel], settings, { scope: 'generated' }).source;
  }
  result.pathAnalysis = analyzePathEnvelopes(clean, { ...settings, pathGeometry: result.pathGeometry ?? undefined });
  const mapped = remapWaitOverrides(originalBlocks, clean, settings, overrides);
  const blocks = parseBoth(clean, settings, mapped.blockIdentities);
  const baseline = estimateCycle(blocks.h, blocks.v, settings, mapped.overrides);
  const work = (channel) => baseline.channels[channel].cut + baseline.channels[channel].air + baseline.channels[channel].toolChange;
  result.longerChannel = work('v') > work('h') ? 'v' : 'h';

  const programs = {};
  for (const channel of CHANNELS) {
    if (blocks[channel].some((block) => block.sync)) {
      result.errors.push(`${channel.toUpperCase()}: imported waits or macro synchronization remain. Clear or review them explicitly before automatically placing new waits.`);
    }
    programs[channel] = readOperations(clean[channel], channel, result.errors);
    const parsed = parseProgram(clean[channel], settings, channel);
    if (parsed.diagnostics.length) result.errors.push(`${channel.toUpperCase()}: resolve parser review notes before automatically placing waits.`);
  }
  if (!baseline.complete) result.errors.push('Every operation needs a known duration. Enter manual times for unmodeled motion before planning waits.');
  if (result.errors.length) return result;

  for (const channel of CHANNELS) {
    const spans = blockSpans(blocks[channel]);
    for (const op of programs[channel].operations) {
      op.blocks = spans.filter((span) => span.start < op.end && span.end > op.start);
      op.duration = op.blocks.reduce((sum, span) => sum + (baseline.blockTimes[span.block.id]?.duration ?? 0), 0);
      op.manual = op.blocks.some((span) => readOverride(mapped.overrides[span.block.id]) !== null);
      if (channel === 'h' && op.window && !op.manual) {
        op.window.seconds = windowSeconds(blocks.h, op.window, settings, mapped.overrides);
      }
    }
  }

  // The pending V operation is reconsidered at every H operation. A failed
  // window never causes another V operation to overtake it.
  let nextV = 0;
  const assignments = [];
  for (const h of programs.h.operations) {
    result.annotations.push(annotation('h', h.number, '1', null, null));
    const v = programs.v.operations[nextV];
    if (!v) continue;
    result.annotations.push(annotation('v', v.number, '2(wait)', h.number, null));
    const path = result.pathAnalysis.conflicts.find((pair) => pair.hEvent === h.number && pair.vEvent === v.number);
    const laterHClear = programs.h.operations.filter((later) => later.number > h.number).every((later) => !later.hasBT && result.pathAnalysis.conflicts.some((pair) => pair.hEvent === later.number && pair.vEvent === v.number && pair.clear));
    const overlap = permittedOverlap(h, v, path, laterHClear);
    let mode;
    let reason;
    if (overlap.allowed) {
      mode = 'overlap';
      reason = overlap.window.inferred
        ? 'Known complete XYZ paths are separated by the configured clearance; V fits inside this fixed-B H operation.'
        : 'Known complete XYZ paths are separated by the configured clearance; V fits inside the explicit H window.';
    } else if (h.clear && v.clear && !overlap.defer) {
      mode = 'sequential';
      reason = `${overlap.reason} H asserts clearance at its operation end; H waits there until V completes.`;
    } else {
      result.notes.push(`V event ${v.number} remains 2(wait) at H event ${h.number}: ${overlap.reason}${h.clear && v.clear ? '' : ' Both H and V need end-clearance assertions for sequential release.'}`);
      continue;
    }
    const pair_id = assignments.length + 1;
    result.annotations.at(-1).pair_id = pair_id;
    assignments.push({ h, v, mode, reason, pair_id, window: overlap.window });
    nextV += 1;
  }
  if (nextV < programs.v.operations.length) {
    result.errors.push(`V event ${programs.v.operations[nextV].number} has no permitted release in the remaining H operations. Add an explicit safe window or an H (SYNC CLEAR) boundary; remaining events were not moved to the end.`);
    return result;
  }
  const startId = Number(options.startId ?? 301);
  const configuredParticipants = `${settings.hChannel ?? '1'}${settings.vChannel ?? '2'}`;
  const participants = String(options.participants ?? configuredParticipants);
  if (!Number.isSafeInteger(startId) || startId < 0 || !/^[1-4]{2}$/.test(participants) || participants[0] === participants[1] || participants !== configuredParticipants) {
    result.errors.push('Choose a non-negative integer wait ID and the configured H/V participating machine channels (1–4), in H/V order.');
    return result;
  }
  const usedCodeIds = new Set(CHANNELS.flatMap((channel) => programs[channel].lines.flatMap((line) => [...line.code.matchAll(/M\s*(\d+)(?![\d.])/gi)].map((match) => Number(match[1])))));
  const insertions = { h: new Map(), v: new Map() };
  for (const assignment of assignments) {
    const { h, v, mode, pair_id, reason, window } = assignment;
    const releaseId = startId + (pair_id - 1) * 2;
    const completeId = releaseId + 1;
    const codes = [releaseId, completeId].map((id) => renderWait(id, participants, settings, pattern, result.errors, usedCodeIds));
    if (result.errors.length) return result;
    const release = `${codes[0]} (${AUTO_WAIT_MARKER} ${pair_id} RELEASE)`;
    const complete = `${codes[1]} (${AUTO_WAIT_MARKER} ${pair_id} COMPLETE)`;
    addInsertion(insertions.v, v.start, release);
    addInsertion(insertions.v, v.end, complete);
    addInsertion(insertions.h, mode === 'overlap' ? window.start : h.end, release);
    addInsertion(insertions.h, mode === 'overlap' ? window.end : h.end, complete);
    result.rows.push({
      hEvent: h.number, vEvent: v.number, hN: h.terminalN, vN: v.terminalN,
      pair_id, mode, releaseId, completeId, reason,
      hSeconds: h.duration, vSeconds: v.duration,
      windowSeconds: mode === 'overlap' ? window.seconds : null,
      flags: ['2(wait)', '2(release)', '1(wait)', '1(release)'],
    });
    result.annotations.push(
      annotation('v', v.number, '2(release)', h.number, pair_id),
      annotation('h', h.number, '1(wait)', h.number, pair_id),
      annotation('h', h.number, '1(release)', h.number, pair_id),
    );
  }
  const planned = {};
  for (const channel of CHANNELS) planned[channel] = insertAtOffsets(clean[channel], insertions[channel]);
  const finalMap = remapWaitOverrides(originalBlocks, planned, settings, overrides);
  const finalBlocks = parseBoth(planned, settings, finalMap.blockIdentities);
  const timing = estimateCycle(finalBlocks.h, finalBlocks.v, settings, finalMap.overrides);
  if (!timing.complete || timing.diagnostics.some((note) => note.level === 'error')) {
    result.errors.push('The generated NC did not pass the complete, stall-free schedule check. No source changes were produced.');
    return result;
  }
  result.sources = planned;
  result.overrides = finalMap.overrides;
  result.blockIdentities = finalMap.blockIdentities;
  result.timing = timing;
  result.waitCount = assignments.length * 4;
  result.notes.push('Operations retain their original order. This conservative pass releases at most one V event per H event and does not claim a globally optimal cycle.');
  result.notes.push('SYNC markers assert clearance supplied by the NC author. Command-time estimates do not validate machine geometry, stock, fixtures, or real collision clearance.');
  return result;
}

function permittedOverlap(h, v, path, laterHClear) {
  if (h.window && v.envelope && h.window.envelope === v.envelope) return { allowed: false, reason: 'The tools use the same asserted envelope.' };
  if (v.hasBT) return { allowed: false, reason: 'V contains a B-axis move or tool change, which cannot overlap H.' };
  if (!path?.clear) return { allowed: false, reason: path?.kind === 'possible-overlap' ? 'The actual swept XYZ envelopes may overlap; different marker names cannot authorize simultaneous paths.' : 'The full swept XYZ paths and required tool/holder clearance are not resolved.' };
  if (!v.clear && !laterHClear) return { allowed: false, reason: 'V has no end-clearance assertion and its stationary end position is not separated from every later H path. Later H rotation and tool changes require explicit V clearance.' };
  let window;
  if (h.window && !h.manual && v.envelope && v.clear) window = h.window;
  else if (!h.hasBT) window = { start: h.start, end: h.end, seconds: h.duration, inferred: true };
  else return { allowed: false, reason: 'H contains a B-axis move or tool change outside a fully established overlap window.' };
  if (!(window.seconds >= v.duration - 1e-9)) return { allowed: false, defer: true, reason: `V needs ${v.duration.toFixed(3)} s; the H window provides ${window.seconds.toFixed(3)} s. It will be retried at the next H event.` };
  return { allowed: true, window };
}

function readOperations(source, channel, errors) {
  const prefix = `${channel.toUpperCase()}: `;
  const lines = withCommentsBlanked(splitLines(source));
  let offset = 0;
  let depth = 0;
  let ended = false;
  let pendingStart = null;
  let pendingLines = [];
  const operations = [];
  for (const line of lines) {
    line.offset = offset;
    line.end = offset + line.raw.length;
    const startsInComment = depth > 0;
    for (const char of line.content) {
      if (char === ';' && !depth) break;
      if (char === '(') depth += 1;
      else if (char === ')') {
        if (!depth) errors.push(`${prefix}unmatched closing comment at line ${line.line}.`);
        else depth -= 1;
      }
    }
    if (CONTROL.test(line.code)) errors.push(`${prefix}control flow, macros, subprograms, stops, or optional execution at line ${line.line} require manual scheduling.`);
    if (line.raw.length > 2048 && /M\s*\d/i.test(line.code)) errors.push(`${prefix}split long executable lines before automatic wait placement.`);
    if (END.test(line.code)) {
      if (ended) errors.push(`${prefix}only one program end is supported.`);
      ended = true;
      if (pendingLines.some(hasWork)) errors.push(`${prefix}executable tail before M2/M30 has no ending N operation marker.`);
      pendingLines = [];
      pendingStart = null;
    } else if (ended) {
      if (line.code.trim() && line.code.trim() !== '%') errors.push(`${prefix}executable code after M2/M30 is not supported.`);
    } else if (HEADER.test(line.code)) {
      if (operations.length || pendingLines.some(hasWork)) errors.push(`${prefix}program headers may only precede the first operation.`);
      pendingLines = [];
      pendingStart = null;
    } else {
      pendingStart ??= line.offset;
      line.marker = !startsInComment ? marker(line) : null;
      if (!startsInComment && /\(\s*SYNC\b/i.test(line.content) && !line.marker) errors.push(`${prefix}malformed or inline SYNC assertion at line ${line.line}; use its own complete comment line.`);
      pendingLines.push(line);
      if (N_END.test(line.code)) {
        const op = { number: operations.length + 1, start: pendingStart, end: line.end, terminalN: line.code.match(N_END)[0].trim(), lines: pendingLines, hasBT: pendingLines.some((entry) => BT_WORD.test(entry.code)) };
        readAssertions(op, channel, errors);
        operations.push(op);
        pendingLines = [];
        pendingStart = null;
      }
    }
    offset = line.end;
  }
  if (depth) errors.push(`${prefix}close all parenthesis comments before automatic wait placement.`);
  if (!ended) errors.push(`${prefix}add a standalone M2 or M30 program end before planning waits.`);
  if (!operations.length) errors.push(`${prefix}no complete operations ending in an N line were found.`);
  return { operations, lines };
}

function marker(line) {
  const match = line.content.match(MARKER);
  if (!match || line.code.trim()) return null;
  const kind = match[1].toUpperCase().replace(/\s+/g, ' ');
  return { kind: kind.startsWith('WINDOW OPEN') ? 'open' : kind === 'WINDOW CLOSE' ? 'close' : kind.startsWith('ENVELOPE') ? 'envelope' : 'clear', envelope: (match[2] ?? match[3])?.toUpperCase() };
}

function readAssertions(op, channel, errors) {
  const find = (kind) => op.lines.filter((line) => line.marker?.kind === kind);
  const opens = find('open');
  const closes = find('close');
  const clear = find('clear');
  const envelopes = find('envelope');
  const label = `${channel.toUpperCase()} event ${op.number}: `;
  if (clear.length > 1 || envelopes.length > 1 || opens.length > 1 || closes.length > 1) errors.push(`${label}use each SYNC assertion only once per operation.`);
  if (clear.length === 1) {
    const laterWork = op.lines.some((line) => line.offset > clear[0].offset && hasWork(line));
    if (laterWork) errors.push(`${label}(SYNC CLEAR) must follow all executable work and precede the ending N line.`);
    else op.clear = true;
  }
  op.envelope = envelopes.length === 1 ? envelopes[0].marker.envelope : null;
  if (opens.length || closes.length) {
    if (channel !== 'h' || opens.length !== 1 || closes.length !== 1 || opens[0].offset >= closes[0].offset) {
      errors.push(`${label}one ordered WINDOW OPEN/CLOSE pair is supported on H only.`);
    } else {
      const body = op.lines.filter((line) => line.offset >= opens[0].end && line.offset < closes[0].offset);
      if (body.some((line) => BT_WORD.test(line.code))) errors.push(`${label}B-axis motion or a tool change inside an H overlap window is not permitted.`);
      op.window = { start: opens[0].end, end: closes[0].offset, envelope: opens[0].marker.envelope };
    }
  }
}

function hasWork(line) {
  return !!line.code.replace(N_END, '').trim();
}

function windowSeconds(blocks, window, settings, overrides) {
  const split = [];
  const bodyIds = [];
  for (const span of blockSpans(blocks)) {
    const cuts = [span.start, window.start, window.end, span.end].filter((value) => value >= span.start && value <= span.end).sort((a, b) => a - b);
    const unique = [...new Set(cuts)];
    for (let i = 1; i < unique.length; i += 1) {
      const start = unique[i - 1];
      const end = unique[i];
      const whole = start === span.start && end === span.end;
      const text = span.block.text.slice(start - span.start, end - span.start);
      const block = whole ? span.block : { ...span.block, id: `${span.block.id}-window-${i}`, text, flags: analyzeFlags(withCommentsBlanked(splitLines(text)).map((line) => line.code).join('\n')) };
      split.push(block);
      if (start >= window.start && end <= window.end) bodyIds.push(block.id);
    }
  }
  const timing = estimateCycle(split, [], settings, overrides);
  return timing.complete ? bodyIds.reduce((sum, id) => sum + (timing.blockTimes[id]?.duration ?? 0), 0) : NaN;
}

function renderWait(id, participants, settings, pattern, errors, used) {
  const template = settings.waitTemplate ?? 'M{id}P{p}';
  if (typeof template !== 'string' || !template.includes('{id}') || /[\r\n();]/.test(template)) {
    errors.push('The wait template must be a single executable instruction containing {id}.');
    return '';
  }
  const code = template.replaceAll('{id}', String(id)).replaceAll('{p}', participants).trim();
  pattern.regex.lastIndex = 0;
  const matches = [...code.matchAll(pattern.regex)];
  const match = matches[0];
  if (!Number.isSafeInteger(id) || matches.length !== 1 || match[0] !== code || match[1] !== String(id) || (match[2] !== undefined && match[2] !== participants)) {
    errors.push(`Wait ID ${id} cannot be emitted exactly by the configured wait template/pattern. The supported ID range may be exhausted; choose another start ID or update Settings.`);
  } else if (used.has(id)) errors.push(`Wait ID ${id} already occurs in executable NC. Choose a different start ID; IDs are never reused.`);
  used.add(id);
  return code;
}

function annotation(channel, event, pairing, paired_with, pair_id) {
  return { channel, event, pairing, paired_with, pair_id };
}

function addInsertion(map, offset, text) {
  if (!map.has(offset)) map.set(offset, []);
  map.get(offset).push(text);
}

function insertAtOffsets(source, insertions) {
  const eol = lineEnding(source);
  let result = '';
  let last = 0;
  for (const [offset, lines] of [...insertions].sort((a, b) => a[0] - b[0])) {
    result += source.slice(last, offset) + lines.join(eol) + eol;
    last = offset;
  }
  return result + source.slice(last);
}

function parseBoth(sources, settings, identities) {
  return Object.fromEntries(CHANNELS.map((channel) => {
    const blocks = parseProgram(sources[channel], settings, channel).blocks;
    if (identities?.[channel]) blocks.forEach((block, index) => { block.id = identities[channel][index]?.id ?? block.id; });
    return [channel, blocks];
  }));
}

function blockSpans(blocks) {
  let offset = 0;
  return blocks.map((block) => {
    const span = { block, start: offset, end: offset + block.text.length };
    offset = span.end;
    return span;
  });
}

/**
 * Keep exact block identities; carry manual times across removal of generated
 * barriers by adding the durations of code fragments that become one block.
 * The planner never splits a manually timed operation for an overlap window.
 */
export function remapWaitOverrides(originalBlocks, nextSources, settings = {}, originalOverrides = {}) {
  const next = parseBoth(nextSources, settings);
  const timing = estimateCycle(originalBlocks.h, originalBlocks.v, settings, originalOverrides);
  const overrides = {};
  const blockIdentities = { h: [], v: [] };
  const usedIds = new Set();
  for (const channel of CHANNELS) {
    const old = originalBlocks[channel] ?? [];
    const queues = new Map();
    for (const block of old) {
      if (!queues.has(block.text)) queues.set(block.text, []);
      queues.get(block.text).push(block);
    }
    let oldCode = codeSpans(old, settings);
    let newCode = codeSpans(next[channel], settings);
    const concatenated = (spans) => spans.map((span) => span.text).join('');
    if (concatenated(oldCode) !== concatenated(newCode)) {
      oldCode = codeSpans(old, settings, 'recognized');
      newCode = codeSpans(next[channel], settings, 'recognized');
    }
    const sameCode = concatenated(oldCode) === concatenated(newCode);
    const newSpans = new Map(newCode.map((span) => [span.block, span]));
    next[channel].forEach((block, index) => {
      const exact = queues.get(block.text)?.shift();
      let id = exact?.id ?? `${channel}-auto-${block.startLine}-${index}`;
      while (usedIds.has(id)) id += '-new';
      usedIds.add(id);
      blockIdentities[channel].push({ id, text: block.text });
      if (exact && readOverride(originalOverrides[exact.id]) !== null) {
        overrides[id] = originalOverrides[exact.id];
        return;
      }
      const span = newSpans.get(block);
      if (!sameCode || !span || block.sync) return;
      const parts = oldCode.filter((part) => part.start < span.end && part.end > span.start);
      if (!parts.some((part) => readOverride(originalOverrides[part.block.id]) !== null)) return;
      // Whole fragments can be merged exactly. Splitting a manual measurement
      // would invent an internal duration, so do not manufacture that override.
      if (parts.some((part) => part.start < span.start || part.end > span.end)) return;
      if (parts.some((part) => !part.block.sync && timing.blockTimes[part.block.id]?.unknown)) return;
      overrides[id] = parts.reduce((sum, part) => sum + (part.block.sync ? 0 : timing.blockTimes[part.block.id]?.duration ?? 0), 0);
    });
  }
  return { overrides, blockIdentities };
}

function codeSpans(blocks, settings, scope = 'generated') {
  let offset = 0;
  return blocks.map((block) => ({ block, text: clearWaitCodes(block.text, settings, { scope }).source })).filter((part) => part.text !== '').map(({ block, text }) => {
    const span = { block, text, start: offset, end: offset + text.length };
    offset = span.end;
    return span;
  });
}
