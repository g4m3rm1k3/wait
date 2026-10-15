/**
 * Lines up the two channels side by side at their synchronization points.
 *
 * Two kinds of link exist between the channels:
 *
 *   Barrier (paired wait)   M301P12 in both programs. Each channel stops at it
 *                           until the other one arrives; then both continue.
 *
 *   Macro (one-way)         One channel sets a shared variable (#501=20) and
 *                           the other waits in WHILE[#501NE20]DO1 / END1 until
 *                           it sees that value. The setter does NOT stop.
 *
 * The result is a list of display rows. Rows never reorder either program;
 * when one channel has more blocks between two links, the other side gets an
 * empty "alignment spacer". Rows are an editing aid, not a timing schedule —
 * see timing/estimate.js for when things actually happen.
 *
 * Problems found along the way (unpaired waits, crossed waits that would
 * deadlock, macro races) are reported as diagnostics.
 */
import { isNumberLiteral, canonicalNumber } from '../nc/numbers.js';
import { bestIncreasingPairs, byHorizontalIndex } from './monotone-pairs.js';
import { findMacroDependencyCycles } from './dependency-cycles.js';

const CHANNELS = ['h', 'v'];

/**
 * @param {object[]} horizontal  Parsed horizontal blocks.
 * @param {object[]} vertical    Parsed vertical blocks.
 * @param {object} [options]
 * @param {boolean} [options.includeMacroAnchors=true]  Let macro links share rows too.
 * @param {boolean} [options.warnMacroRaces=true]       Report possible macro overwrites.
 * @returns {{rows: object[], links: object[], diagnostics: object[], matchedCount: number}}
 *   rows:  { h: block|null, v: block|null, type: 'content'|'sync', key? }
 *   links: every recognized pair, with `aligned` telling whether it shares a row.
 */
export function alignChannels(horizontal = [], vertical = [], options = {}) {
  const hBlocks = Array.isArray(horizontal) ? horizontal : [];
  const vBlocks = Array.isArray(vertical) ? vertical : [];
  const notes = new Notes();
  const useMacroAnchors = options.includeMacroAnchors !== false;

  // 1. Find every sync statement in both channels, grouped by matching key.
  const points = collectSyncPoints({ h: hBlocks, v: vBlocks }, notes);

  // 2. Pair them across the channels.
  const candidates = [...pairBarriers(points.barriers, notes), ...pairMacros(points.macros, notes)];
  const barrierPairs = candidates.filter((pair) => pair.kind === 'barrier').sort(byHorizontalIndex);
  const macroPairs = candidates.filter((pair) => pair.kind === 'macro');

  // 3. Check the pairs for problems.
  checkCrossedBarriers(barrierPairs, notes);
  if (points.macros.size) {
    notes.add('info', 'macro-static-only', 'Macro links show source dependencies only. Assignments do not hold the producing channel; initial values, execution timing, branching and machine interlocks are not established by this alignment.');
  }
  checkSharedWriters(points.writers, notes);
  if (options.warnMacroRaces !== false) checkMacroRaces(macroPairs, barrierPairs, points.writers, notes);
  for (const entries of findMacroDependencyCycles(hBlocks, vBlocks, barrierPairs, macroPairs)) {
    notes.add('warning', 'macro-dependency-cycle', 'Macro wait dependencies form a cycle in source order: a needed assignment is reached only after a wait that depends back on this channel. Review initial values and execution; this can deadlock.', entries);
  }

  // 4. Choose which pairs share a row. They must be in the same order in both
  //    channels; barriers win over macros when they conflict.
  const anchors = bestIncreasingPairs(useMacroAnchors ? candidates : barrierPairs, vBlocks.length);
  const aligned = new Set(anchors);
  if (useMacroAnchors) {
    for (const pair of macroPairs) {
      if (aligned.has(pair)) continue;
      notes.add('warning', 'macro-visual-conflict', `${pair.key} is linked across channels but cannot share a row without changing source order or displacing a barrier. Its directional dependency remains visible in the link.`, [pair.h, pair.v]);
    }
  }

  return {
    rows: buildRows(hBlocks, vBlocks, anchors),
    links: candidates.map((pair) => describeLink(pair, aligned.has(pair))),
    diagnostics: notes.list,
    matchedCount: anchors.length,
  };
}

// ---------------------------------------------------------------------------
// Step 1: collect
// ---------------------------------------------------------------------------

/**
 * A sync statement at one position in one channel.
 * @typedef {{block: object, index: number, channel: 'h'|'v', sync: object, variable?: string, value?: string, key?: string}} SyncEntry
 */

/**
 * Group sync statements by key.
 *   barriers: key -> { h: SyncEntry[], v: SyncEntry[] }
 *   macros:   "#501=20" -> { h: {signal: [], wait: []}, v: {signal: [], wait: []} }
 *   writers:  variable -> every SyncEntry that assigns it
 */
function collectSyncPoints(blocksByChannel, notes) {
  const barriers = new Map();
  const macros = new Map();
  const writers = new Map();

  for (const channel of CHANNELS) {
    blocksByChannel[channel].forEach((block, index) => {
      const sync = block.sync;
      if (!sync) return;
      const entry = { block, index, channel, sync };

      if (sync.kind === 'barrier') {
        const key = String(sync.key ?? '').trim();
        if (!key) {
          notes.add('warning', 'sync-unsupported', 'A barrier has no recognized matching key.', [entry]);
          return;
        }
        getOrCreate(barriers, key, () => ({ h: [], v: [] }))[channel].push(entry);
        return;
      }

      if (sync.kind === 'macro') {
        if (!['signal', 'wait'].includes(sync.role)) {
          notes.add('warning', 'macro-unsupported', 'A macro synchronization statement has an unsupported role.', [entry]);
          return;
        }
        const variable = normalizeVariable(sync.variable);
        const value = sync.value == null ? '' : normalizeValue(sync.value);
        const key = variable && value ? `#${variable}=${value}` : String(sync.key ?? '').replace(/\s+/g, '').toUpperCase();
        if (!key) {
          notes.add('warning', 'macro-unsupported', 'A macro synchronization statement has no recognized variable/value key.', [entry]);
          return;
        }
        Object.assign(entry, { variable, value, key });
        getOrCreate(macros, key, () => ({ h: { signal: [], wait: [] }, v: { signal: [], wait: [] } }))[channel][sync.role].push(entry);
        if (sync.role === 'signal' && variable) getOrCreate(writers, variable, () => []).push(entry);
        return;
      }

      notes.add('warning', 'sync-unsupported', 'An unrecognized synchronization statement could not be aligned.', [entry]);
    });
  }
  return { barriers, macros, writers };
}

// ---------------------------------------------------------------------------
// Step 2: pair
// ---------------------------------------------------------------------------

/**
 * Barriers pair by occurrence: the 1st M301P12 in H with the 1st in V, the
 * 2nd with the 2nd, and so on. Leftovers have no partner and are errors.
 */
function pairBarriers(barriers, notes) {
  const pairs = [];
  for (const [key, group] of barriers) {
    const count = Math.min(group.h.length, group.v.length);
    const repeated = Math.max(group.h.length, group.v.length) > 1;
    for (let i = 0; i < count; i += 1) {
      pairs.push(makePair(group.h[i], group.v[i], {
        key,
        kind: 'barrier',
        occurrence: i + 1,
        label: `WAIT ${key}${repeated ? ` · occurrence ${i + 1}` : ''}`,
      }));
    }
    for (const channel of CHANNELS) {
      group[channel].slice(count).forEach((entry, index) => {
        notes.add('error', 'barrier-unmatched', `${channelName(channel)} barrier ${key} (occurrence ${count + index + 1}) has no opposite-channel partner. Check the wait pattern and participant setting.`, [entry]);
      });
    }
  }
  return pairs;
}

/**
 * A macro link needs exactly one assignment in one channel and exactly one
 * matching wait in the other. Repeats are ambiguous from source alone and are
 * left unpaired with a warning.
 */
function pairMacros(macros, notes) {
  const pairs = [];
  for (const [key, group] of macros) {
    for (const producer of CHANNELS) {
      const consumer = opposite(producer);
      const signals = group[producer].signal;
      const waits = group[consumer].wait;

      if (signals.length === 1 && waits.length === 1) {
        const [signal] = signals;
        const [wait] = waits;
        pairs.push(makePair(producer === 'h' ? signal : wait, producer === 'v' ? signal : wait, {
          key,
          kind: 'macro',
          signal,
          wait,
          label: `${key} · ${producer.toUpperCase()} → ${consumer.toUpperCase()}`,
        }));
      } else if (signals.length && waits.length) {
        notes.add('warning', 'macro-ambiguous', `${key} has ${signals.length} ${channelName(producer).toLowerCase()} assignment(s) and ${waits.length} opposite-channel wait(s). Repeated values cannot be paired reliably from source alone; these statements were left unaligned.`, [...signals, ...waits]);
      } else if (waits.length) {
        notes.add('warning', 'macro-unresolved-wait', `${channelName(consumer)} waits for ${key}, but no opposite-channel assignment was recognized. The value may depend on initial state or code outside this view.`, waits);
      } else if (signals.length) {
        notes.add('info', 'macro-unused-signal', `${channelName(producer)} assigns ${key} with no recognized opposite-channel equality wait.`, signals);
      }
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Step 3: check
// ---------------------------------------------------------------------------

/**
 * Barriers must appear in the same order in both programs. If H waits at A
 * then B, but V waits at B then A, each channel waits for the other forever.
 * `barrierPairs` must be sorted by horizontal position.
 */
function checkCrossedBarriers(barrierPairs, notes) {
  let furthest = null; // the pair reached latest in the vertical program so far
  const crossed = [];
  for (const pair of barrierPairs) {
    if (furthest && pair.v.index < furthest.v.index) crossed.push(pair.h, pair.v, furthest.h, furthest.v);
    if (!furthest || pair.v.index > furthest.v.index) furthest = pair;
  }
  if (crossed.length) {
    notes.add('error', 'sync-cycle', 'Barrier order is crossed between the channels. Each channel can reach a different barrier first and wait indefinitely. Source order has been preserved; conflicting barriers cannot share rows.', crossed);
  }
}

/** Both channels writing the same variable can overwrite each other's signal. */
function checkSharedWriters(writers, notes) {
  for (const [variable, entries] of writers) {
    if (new Set(entries.map((entry) => entry.channel)).size > 1) {
      notes.add('warning', 'macro-multiple-writers', `Both channels write #${variable}. Shared values can be overwritten; review ownership and initial values.`, entries);
    }
  }
}

/**
 * A wait only sees the variable's value at the moment it checks. If the
 * producer sets #501=20 and then soon #501=30, the waiting channel may never
 * see 20. This is safe only when a barrier after the consumer's wait holds
 * the producer back before the second assignment.
 */
function checkMacroRaces(macroPairs, barrierPairs, writers, notes) {
  for (const pair of macroPairs) {
    const { signal, wait } = pair;
    if (!signal.variable) continue;

    const laterWrites = (writers.get(signal.variable) ?? []).filter((entry) => {
      if (entry === signal || entry.channel !== signal.channel || entry.index <= signal.index) return false;
      const protectedByBarrier = barrierPairs.some((barrier) => {
        const producerSide = barrier[signal.channel];
        const consumerSide = barrier[wait.channel];
        return producerSide.index > signal.index && producerSide.index < entry.index && consumerSide.index > wait.index;
      });
      return !protectedByBarrier;
    });

    if (laterWrites.length) {
      notes.add('warning', 'macro-equality-race', `${pair.key} can be overwritten by its producer before the opposite equality wait is known to have observed it. A missed value can leave the wait running indefinitely.`, [signal, wait, ...laterWrites]);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 4: rows
// ---------------------------------------------------------------------------

/**
 * Walk both programs in order. Each anchor pair gets its own row; blocks in
 * between are laid side by side, with null (a spacer) where one side runs out.
 */
function buildRows(hBlocks, vBlocks, anchors) {
  const rows = [];
  let h = 0;
  let v = 0;
  const addContentUntil = (hEnd, vEnd) => {
    while (h < hEnd || v < vEnd) {
      rows.push({ h: h < hEnd ? hBlocks[h++] : null, v: v < vEnd ? vBlocks[v++] : null, type: 'content' });
    }
  };
  for (const pair of anchors) {
    addContentUntil(pair.h.index, pair.v.index);
    rows.push({ h: pair.h.block, v: pair.v.block, key: pair.key, type: 'sync' });
    h += 1;
    v += 1;
  }
  addContentUntil(hBlocks.length, vBlocks.length);
  return rows;
}

function describeLink(pair, aligned) {
  return {
    key: pair.key,
    hId: pair.h.block.id,
    vId: pair.v.block.id,
    kind: pair.kind,
    label: pair.label,
    aligned,
    ...(pair.kind === 'macro' ? { signalId: pair.signal.block.id, waitId: pair.wait.block.id, producer: pair.signal.channel } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collects diagnostics as { level, code, message, blockIds? }. */
class Notes {
  constructor() {
    this.list = [];
  }

  add(level, code, message, entries = []) {
    const ids = [...new Set(entries.map((entry) => entry.block.id).filter((id) => id != null))];
    this.list.push({ level, code, message, ...(ids.length ? { blockIds: ids } : {}) });
  }
}

function getOrCreate(map, key, create) {
  if (!map.has(key)) map.set(key, create());
  return map.get(key);
}

/** "#0501" and "501" are the same variable. */
function normalizeVariable(value) {
  if (value == null) return '';
  const text = String(value).replace(/^#/, '').trim();
  return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, '') : text.toUpperCase();
}

/** "20.0" and "20" are the same value; non-numbers are compared as upper-case text. */
function normalizeValue(value) {
  const text = String(value).replace(/\s+/g, '').toUpperCase();
  return isNumberLiteral(text) ? canonicalNumber(text) : text;
}

function opposite(channel) {
  return channel === 'h' ? 'v' : 'h';
}

function channelName(channel) {
  return channel === 'h' ? 'Horizontal' : 'Vertical';
}

function makePair(h, v, details) {
  return { h, v, ...details };
}
