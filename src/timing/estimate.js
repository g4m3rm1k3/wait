/**
 * Estimated cycle time for the linked pair of channels.
 *
 * This is a command-time estimate only. It does not model acceleration,
 * stock contact, machine interlocks, coordinate transforms or collisions.
 * All times are seconds; utilization values are fractions from 0 to 1.
 *
 * Pipeline:
 *   1. motion.js     each channel's blocks -> timed actions
 *   2. overrides.js  manual block times replace modeled ones
 *   3. scheduler.js  both channels run together; waits are worked out
 *   4. coverage.js   totals and cutting statistics
 */
import { ChannelInterpreter } from './motion.js';
import { applyManualTime, readOverride } from './overrides.js';
import { macroNumber, variableKey } from './macro-values.js';
import { runSchedule } from './scheduler.js';
import { channelTotals, cuttingCoverage } from './coverage.js';
import { TimingReport } from './report.js';

export const TIMING_DEFAULTS = {
  cutFeed: 600, // mm/min, used when a G1 has no F or programmed feeds are off
  rapidFeed: 10000, // mm/min
  toolChangeSeconds: 8,
  rotationFeed: 180, // B axis, degrees/min
  initialMacros: {}, // { '501': 0 } values of shared variables at cycle start
  useProgramFeed: true,
};

/**
 * @param {object[]} hBlocks  parsed horizontal blocks
 * @param {object[]} vBlocks  parsed vertical blocks
 * @param {object} [config]   timing settings (see TIMING_DEFAULTS)
 * @param {Record<string, number>} [overrides]  manual seconds per block id
 * @returns {{
 *   duration: number,                       estimated cycle time
 *   channels: {h: object, v: object},       cut / air / toolChange / wait totals
 *   segments: {h: object[], v: object[]},   timeline pieces
 *   blockTimes: Record<string, object>,     time per block, including waits
 *   diagnostics: object[],
 *   coverage: object,                       see coverage.js
 *   complete: boolean                       false when any time is unknown
 * }}
 */
export function estimateCycle(hBlocks = [], vBlocks = [], config = {}, overrides = {}) {
  const settings = normalizeSettings(config);
  const report = new TimingReport();
  const blockTimes = {};

  const actionsByChannel = {
    h: channelActions('h', hBlocks, settings, overrides, blockTimes, report),
    v: channelActions('v', vBlocks, settings, overrides, blockTimes, report),
  };

  const macros = initialMacroValues(settings.initialMacros, report);
  const { now, segments, finishedAt } = runSchedule(actionsByChannel, macros, blockTimes, report);

  return {
    duration: now,
    channels: channelTotals(segments, finishedAt, now),
    segments,
    blockTimes,
    diagnostics: report.diagnostics,
    coverage: cuttingCoverage(segments, now),
    complete: report.complete,
  };
}

/** Read every block of one channel into actions and fill in its time totals. */
function channelActions(channel, blocks, settings, overrides, blockTimes, report) {
  const interpreter = new ChannelInterpreter(channel, settings, report);
  const allActions = [];

  blocks.forEach((block, index) => {
    const id = String(block.id ?? `${channel}-${index}`);
    const read = interpreter.readBlock(block, id);
    if (read.afterEnd) {
      blockTimes[id] = { duration: 0, cut: 0, air: 0, toolChange: 0 };
      return;
    }

    let actions = read.actions;
    const manual = readOverride(overrides[id]);
    if (manual !== null && !Number.isNaN(manual) && !block.sync && !read.isSimpleWait) {
      actions = applyManualTime(actions, manual, block, read.cleanText, id);
    } else if (Number.isNaN(manual)) {
      report.warn('invalid-override', 'Manual block time must be a non-negative number of seconds.', [id]);
    }

    const unresolved = actions.some((action) => action.type === 'unknown');
    const times = { duration: 0, cut: 0, air: 0, toolChange: 0, ...(unresolved ? { unknown: true } : {}) };
    for (const action of actions) {
      if (action.kind !== 'time') continue;
      times.duration += action.duration;
      if (['cut', 'air', 'toolChange'].includes(action.type)) times[action.type] += action.duration;
    }
    blockTimes[id] = times;

    if (unresolved) {
      report.markIncomplete();
      report.warn('unknown-block-time', `Enter a manual time for this block. ${[...new Set(read.unknownMessages)].join(' ')}`, [id]);
    }
    allActions.push(...actions);
  });
  return allActions;
}

/** Shared variable values at cycle start; values that cannot be modeled stay unknown. */
function initialMacroValues(initialMacros, report) {
  const macros = new Map();
  for (const [key, value] of Object.entries(initialMacros ?? {})) {
    const number = macroNumber(value);
    if (number !== undefined) {
      macros.set(variableKey(key), number);
    } else {
      report.markIncomplete();
      report.warn('unsupported-initial-macro', `Initial #${variableKey(key)} is outside the supported macro precision bounds or is not a finite literal; its value remains unknown.`);
    }
  }
  return macros;
}

/** Fill in defaults and replace invalid rates with them. */
function normalizeSettings(config) {
  return {
    ...TIMING_DEFAULTS,
    ...config,
    cutFeed: positive(config.cutFeed, TIMING_DEFAULTS.cutFeed),
    rapidFeed: positive(config.rapidFeed, TIMING_DEFAULTS.rapidFeed),
    rotationFeed: positive(config.rotationFeed, TIMING_DEFAULTS.rotationFeed),
    toolChangeSeconds: positive(config.toolChangeSeconds, TIMING_DEFAULTS.toolChangeSeconds, true),
  };
}

function positive(value, fallback, zeroAllowed = false) {
  const number = Number(value);
  return Number.isFinite(number) && (zeroAllowed ? number >= 0 : number > 0) ? number : fallback;
}
