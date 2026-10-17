/**
 * The workspace: both programs, the settings, manual times, undo history,
 * and everything derived from them (parsed blocks, alignment, timing).
 *
 * This file holds no DOM code. The UI calls the edit methods here, then
 * re-renders. Every edit method that changes the programs records an undo
 * step first (`remember`) and re-parses afterwards (`recalculate`).
 *
 * The source text in `state.sources` is always the truth. Blocks are rebuilt
 * from it after each change.
 */
import { parseProgram } from '../nc/parser.js';
import { serializeProgram, moveBlock, moveRange, moveIntoBlock } from '../nc/edit.js';
import { DEFAULT_WAIT_PATTERN, validateWaitPattern } from '../nc/wait-pattern.js';
import { isProgramBoundary, TITLE_PROGRAM_HEADER, TITLE_PROGRAM_END } from '../nc/titles.js';
import { DEMO } from '../nc/demo-programs.js';
import { SYNC_EXAMPLE } from '../nc/demo-complex.js';
import { opTimesToOverrides } from '../nc/example-times.js';
import { alignChannels } from '../sync/alignment.js';
import { estimateCycle } from '../timing/estimate.js';
import { planWaitCodes, remapWaitOverrides } from '../sync/auto-plan.js';
import { clearWaitCodes } from '../sync/wait-codes.js';
import { CHANNELS } from './dom.js';

const STORAGE_KEY = 'spindle-sync-workspace-v1';
const MAX_UNDO_STEPS = 80;
const DEFAULT_FILENAMES = { h: 'horizontal.nc', v: 'vertical.nc' };

export const DEFAULT_SETTINGS = {
  hChannel: '1', // which of the machine's four channels is the horizontal spindle
  vChannel: '2',
  waitPattern: DEFAULT_WAIT_PATTERN,
  waitParticipantMode: 'exact', // 'exact' = M301P12 only pairs with M301P12; 'ignore' = P is ignored
  waitTemplate: 'M{id}P{p}', // text inserted by "Add sync"
  cutFeed: 600,
  rapidFeed: 10000,
  toolChangeSeconds: 8,
  rotationFeed: 180,
  useProgramFeed: true,
  initialMacrosText: '', // as typed in Settings, e.g. "#501=0, #502=0"
  initialMacros: {}, // parsed from initialMacrosText
};

function exampleState() {
  return {
    sources: { ...DEMO }, // channel -> full program text
    filenames: { ...DEFAULT_FILENAMES },
    settings: { ...DEFAULT_SETTINGS },
    overrides: {}, // block id -> manual seconds
    example: true, // still showing the example programs
    compact: false, // compact block view
  };
}

export class Workspace {
  constructor() {
    this.state = exampleState();
    /** Parsed blocks per channel. */
    this.blocks = { h: [], v: [] };
    /** Full parse results per channel (blocks, diagnostics, eol). */
    this.parsed = {};
    this.alignment = null;
    this.timing = null;
    this.history = []; // undo stack of JSON snapshots
    this.future = []; // redo stack
    this.idCounter = 0;
    this.loadFromBrowser();
  }

  // ---------------------------------------------------------------------------
  // Parsing and derived data
  // ---------------------------------------------------------------------------

  /** Re-parse both programs and recompute alignment and timing. */
  recalculate() {
    for (const channel of CHANNELS) {
      const previous = this.blocks[channel].length ? this.blocks[channel] : (this.state.blockIdentities?.[channel] || []);
      this.parsed[channel] = parseProgram(this.state.sources[channel], this.state.settings, channel);
      this.blocks[channel] = this.keepBlockIds(channel, this.parsed[channel].blocks, previous);
    }
    delete this.state.blockIdentities;
    this.alignment = alignChannels(this.blocks.h, this.blocks.v);
    this.timing = estimateCycle(this.blocks.h, this.blocks.v, this.state.settings, this.state.overrides);
  }

  /**
   * Give re-parsed blocks the ids they had before, matched by identical text,
   * so selection and manual times follow a block when it moves. Blocks whose
   * text changed get a new id.
   */
  keepBlockIds(channel, parsedBlocks, previous) {
    const idsByText = new Map();
    for (const block of previous) {
      if (!idsByText.has(block.text)) idsByText.set(block.text, []);
      idsByText.get(block.text).push(block.id);
    }
    return parsedBlocks.map((block) => ({
      ...block,
      id: idsByText.get(block.text)?.shift() || `${channel}-${Date.now().toString(36)}-${++this.idCounter}`,
    }));
  }

  findBlock(channel, id) {
    return this.blocks[channel].find((block) => block.id === id);
  }

  indexOf(channel, id) {
    return this.blocks[channel].findIndex((block) => block.id === id);
  }

  /** Program header / end blocks cannot be moved. */
  isPinned(block) {
    return isProgramBoundary(block);
  }

  /**
   * Insertion gaps a block may move to: after the leading header blocks and
   * before the program end.
   * @returns {{start: number, end: number}}
   */
  movableRange(channel) {
    const list = this.blocks[channel];
    let start = 0;
    while (start < list.length && list[start].title === TITLE_PROGRAM_HEADER) start += 1;
    let end = list.findIndex((block) => block.title === TITLE_PROGRAM_END);
    if (end < 0) end = list.length;
    return { start, end };
  }

  /** Index range of the toolpath a block belongs to (a single block when it has none). */
  toolpathRange(channel, block) {
    const index = this.blocks[channel].indexOf(block);
    return block.toolpath ? { start: index - (block.toolpath.part - 1), count: block.toolpath.parts } : { start: index, count: 1 };
  }

  /** Insertion gap just before (direction -1) or after (+1) the neighbouring whole toolpath. */
  neighbourToolpathGap(channel, block, direction) {
    const { start, count } = this.toolpathRange(channel, block);
    const neighbour = this.blocks[channel][direction < 0 ? start - 1 : start + count];
    if (!neighbour) return direction < 0 ? start : start + count;
    const range = this.toolpathRange(channel, neighbour);
    return direction < 0 ? range.start : range.start + range.count;
  }

  // ---------------------------------------------------------------------------
  // Edits. Each returns true when something changed.
  // ---------------------------------------------------------------------------

  /** Move one block to insertion gap `to`. */
  moveBlock(channel, from, to) {
    const block = this.blocks[channel][from];
    if (!block || this.isPinned(block)) return false;
    to = this.clampToMovable(channel, to);
    if (from === to || from + 1 === to) return false; // already there
    this.remember();
    this.replaceBlocks(channel, moveBlock(this.blocks[channel], from, to));
    return true;
  }

  /** Move a whole toolpath (all its parts, including waits inside it) to gap `to`. */
  moveToolpath(channel, block, to) {
    const { start, count } = this.toolpathRange(channel, block);
    to = this.clampToMovable(channel, to);
    if (to >= start && to <= start + count) return false; // inside or next to itself
    this.remember();
    this.replaceBlocks(channel, moveRange(this.blocks[channel], start, count, to));
    return true;
  }

  /** Move block `from` into another block, between its lines `line - 1` and `line`. */
  moveIntoLine(channel, from, targetId, line) {
    this.remember();
    this.state.sources[channel] = moveIntoBlock(this.blocks[channel], from, this.indexOf(channel, targetId), line);
    this.recalculate();
    return true;
  }

  /** Replace one block's text after an in-place edit. Records undo; the caller re-renders. */
  replaceBlockText(channel, block, text) {
    this.remember();
    block.text = text;
    this.state.sources[channel] = serializeProgram(this.blocks[channel]);
    this.recalculate();
  }

  removeBlock(channel, id) {
    this.remember();
    this.state.sources[channel] = serializeProgram(this.blocks[channel].filter((block) => block.id !== id));
    this.recalculate();
  }

  /** Replace a whole program (Source view). */
  setSources(changes) {
    this.remember();
    Object.assign(this.state.sources, changes);
    this.recalculate();
  }

  /** Manual time in seconds for a block, or null to go back to the calculated time. */
  setOverride(id, seconds) {
    this.remember();
    if (seconds === null) delete this.state.overrides[id];
    else this.state.overrides[id] = seconds;
    this.recalculate();
  }

  applySettings(settings) {
    this.remember();
    this.state.settings = settings;
    this.recalculate();
  }

  /** @param {'simple'|'sync'} kind  'sync' = the two-part sync example with op-list times */
  loadExample(kind = 'simple') {
    this.remember();
    const sync = kind === 'sync';
    Object.assign(this.state, {
      sources: { ...(sync ? SYNC_EXAMPLE.sources : DEMO) },
      filenames: { ...(sync ? SYNC_EXAMPLE.filenames : DEFAULT_FILENAMES) },
      overrides: {},
      example: true,
    });
    this.blocks = { h: [], v: [] };
    this.recalculate();
    if (sync) {
      // Manual times need block ids, so they are set after the first parse.
      this.state.overrides = opTimesToOverrides(this.blocks, SYNC_EXAMPLE.times);
      this.recalculate();
    }
  }

  /** @param {{h: {source: string, filename: string}, v: {...}}} programs */
  importPrograms(programs) {
    this.remember();
    for (const channel of CHANNELS) {
      this.state.sources[channel] = programs[channel].source;
      this.state.filenames[channel] = programs[channel].filename;
    }
    Object.assign(this.state, { overrides: {}, example: false });
    this.blocks = { h: [], v: [] };
    this.recalculate();
  }

  /**
   * Insert sync code in both channels: after the selected block in its
   * channel, and before the program end in the other.
   * @param {{h: string, v: string}} texts  code to insert, using \n line breaks
   * @param {{channel: string, id: string}|null} selected
   */
  insertSync(texts, selected) {
    this.remember();
    for (const channel of CHANNELS) {
      const list = this.blocks[channel];
      const limits = this.movableRange(channel);
      let index = selected?.channel === channel ? this.indexOf(channel, selected.id) + 1 : limits.end;
      index = Math.min(limits.end, Math.max(limits.start, index));

      const eol = this.parsed[channel].eol || '\n';
      const text = texts[channel].replace(/\n/g, eol) + eol;
      const before = serializeProgram(list.slice(0, index));
      const separator = before && !/[\r\n]$/.test(before) ? eol : '';
      this.state.sources[channel] = before + separator + text + serializeProgram(list.slice(index));
    }
    this.recalculate();
  }

  setCompact(compact) {
    this.state.compact = compact;
  }

  /** Compute a reviewable plan without changing either source or undo history. */
  previewWaitCodes(options = {}) {
    const plan = planWaitCodes(this.state.sources, this.state.settings, this.state.overrides, {
      ...options, blocks: this.blocks,
    });
    return { ...plan, workspaceSnapshot: this.snapshot() };
  }

  /** Apply exactly the preview the user reviewed; reject an obsolete preview. */
  applyWaitPlan(plan) {
    if (!plan || plan.errors?.length || !plan.sources) throw new Error('Preview a complete wait plan first.');
    if (plan.workspaceSnapshot !== this.snapshot()) throw new Error('The workspace changed. Preview placement again before applying.');
    if (CHANNELS.every((channel) => plan.sources[channel] === this.state.sources[channel])) return false;
    this.remember();
    this.state.sources = { ...plan.sources };
    this.state.overrides = { ...plan.overrides };
    if (plan.pathGeometry) this.state.settings = { ...this.state.settings, pathGeometry: plan.pathGeometry };
    this.state.blockIdentities = plan.blockIdentities;
    this.blocks = { h: [], v: [] };
    this.recalculate();
    return true;
  }

  /** Remove only the chosen paired waits, leaving other NC instructions in place. */
  clearWaitCodes(scope = 'generated') {
    const result = Object.fromEntries(CHANNELS.map((channel) => [channel,
      clearWaitCodes(this.state.sources[channel], this.state.settings, { scope }),
    ]));
    const removed = CHANNELS.reduce((total, channel) => total + result[channel].removed, 0);
    const notes = [...new Set(CHANNELS.flatMap((channel) => result[channel].notes))];
    if (!removed) return { removed, notes };
    const sources = Object.fromEntries(CHANNELS.map((channel) => [channel, result[channel].source]));
    const mapped = remapWaitOverrides(this.blocks, sources, this.state.settings, this.state.overrides);
    this.remember();
    this.state.sources = sources;
    this.state.overrides = mapped.overrides;
    this.state.blockIdentities = mapped.blockIdentities;
    this.blocks = { h: [], v: [] };
    this.recalculate();
    return { removed, notes };
  }

  clampToMovable(channel, to) {
    const limits = this.movableRange(channel);
    return Math.min(limits.end, Math.max(limits.start, to));
  }

  /** Use an already re-ordered block list (keeps ids stable when equal texts swap). */
  replaceBlocks(channel, updated) {
    this.state.sources[channel] = serializeProgram(updated);
    this.blocks[channel] = updated;
    this.recalculate();
  }

  // ---------------------------------------------------------------------------
  // Undo / redo
  // ---------------------------------------------------------------------------

  /** Record the current state as an undo step. Call before every change. */
  remember() {
    const current = this.snapshot();
    if (this.history.at(-1) !== current) {
      this.history.push(current);
      if (this.history.length > MAX_UNDO_STEPS) this.history.shift();
    }
    this.future = [];
  }

  undo() {
    if (!this.history.length) return false;
    this.future.push(this.snapshot());
    this.restore(JSON.parse(this.history.pop()));
    return true;
  }

  redo() {
    if (!this.future.length) return false;
    this.history.push(this.snapshot());
    this.restore(JSON.parse(this.future.pop()));
    return true;
  }

  /** Replace the whole workspace with a saved project (validated first). */
  restore(data) {
    this.state = validateProject(data);
    this.blocks = { h: [], v: [] };
    this.recalculate();
  }

  // ---------------------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------------------

  /** Everything needed to restore this workspace, as a plain object. */
  toProject() {
    const identities = (channel) => this.blocks[channel].map((block) => ({ id: block.id, text: block.text }));
    return { ...this.state, format: 'spindle-sync', version: 1, blockIdentities: { h: identities('h'), v: identities('v') } };
  }

  snapshot() {
    return JSON.stringify(this.toProject());
  }

  /** Save in this browser. @returns {boolean} false when browser storage is unavailable */
  saveToBrowser() {
    try {
      localStorage.setItem(STORAGE_KEY, this.snapshot());
      return true;
    } catch {
      return false;
    }
  }

  loadFromBrowser() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && typeof saved.sources?.h === 'string' && typeof saved.sources?.v === 'string') this.state = validateProject(saved);
    } catch {
      // A corrupt or unavailable browser store must not stop the editor.
    }
  }
}

/**
 * Check a saved / imported workspace and fill in defaults.
 * Throws an Error with a user-facing message when it cannot be used.
 */
export function validateProject(input) {
  if (typeof input.sources?.h !== 'string' || typeof input.sources?.v !== 'string') throw new Error('This file does not contain both NC programs.');

  const settings = { ...DEFAULT_SETTINGS, ...input.settings };
  const pattern = validateWaitPattern(settings.waitPattern);
  if (!pattern.valid) throw new Error(pattern.error);
  for (const key of ['cutFeed', 'rapidFeed', 'rotationFeed']) {
    if (!Number.isFinite(Number(settings[key])) || !(Number(settings[key]) > 0)) throw new Error('Feed rates must be finite and greater than zero.');
  }
  if (!Number.isFinite(Number(settings.toolChangeSeconds)) || !(Number(settings.toolChangeSeconds) >= 0)) {
    throw new Error('Tool-change time must be finite and cannot be negative.');
  }
  const channelNumbers = ['1', '2', '3', '4'];
  if (!channelNumbers.includes(String(settings.hChannel)) || !channelNumbers.includes(String(settings.vChannel)) || String(settings.hChannel) === String(settings.vChannel)) {
    throw new Error('Choose two different channels from 1–4.');
  }
  settings.hChannel = String(settings.hChannel);
  settings.vChannel = String(settings.vChannel);
  if (typeof settings.waitTemplate !== 'string' || !settings.waitTemplate.includes('{id}')) throw new Error('The wait insertion template must contain {id}.');
  settings.waitParticipantMode = settings.waitParticipantMode === 'ignore' ? 'ignore' : 'exact';

  const overrides = {};
  if (input.overrides && typeof input.overrides === 'object') {
    for (const [key, value] of Object.entries(input.overrides)) if (Number.isFinite(value) && value >= 0) overrides[key] = value;
  }

  // Saved block ids, so manual times stay attached to the right blocks.
  const blockIdentities = { h: [], v: [] };
  const seen = new Set();
  for (const channel of CHANNELS) {
    if (!Array.isArray(input.blockIdentities?.[channel])) continue;
    for (const item of input.blockIdentities[channel]) {
      if (item && typeof item.id === 'string' && typeof item.text === 'string' && !seen.has(item.id)) {
        blockIdentities[channel].push({ id: item.id, text: item.text });
        seen.add(item.id);
      }
    }
  }

  return {
    sources: { h: input.sources.h, v: input.sources.v },
    filenames: { h: String(input.filenames?.h || DEFAULT_FILENAMES.h), v: String(input.filenames?.v || DEFAULT_FILENAMES.v) },
    settings,
    overrides,
    example: !!input.example,
    compact: !!input.compact,
    blockIdentities,
  };
}
