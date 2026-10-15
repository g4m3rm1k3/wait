/**
 * Runs both channels side by side in simulated time.
 *
 * Each channel works through its action list:
 *   - 'time'      the channel is busy until now + duration
 *   - 'set'       the shared variable changes immediately; the channel goes on
 *   - 'barrier'   the channel stops until the other channel reaches the same
 *                 barrier (same key, same occurrence); then both go on
 *   - 'macroWait' the channel stops until the shared variable has the value
 *
 * The clock jumps from one "a channel finishes its work" moment to the next.
 * If nothing can run and someone is still waiting, the schedule is stalled
 * (a deadlock in the programs) and that is reported as an error.
 *
 * Output is a list of segments per channel ({start, end, type, blockId, label})
 * used for the timeline, plus wait time added to `blockTimes`.
 */
import { EPSILON } from './motion.js';

const CHANNELS = ['h', 'v'];
const MAX_STEPS = 100000;

/**
 * @param {{h: object[], v: object[]}} actionsByChannel
 * @param {Map<string, number>} macros  shared variable values (mutated as the schedule runs)
 * @param {object} blockTimes           per-block time totals; wait time is added here
 * @param {import('./report.js').TimingReport} report
 * @returns {{now: number, segments: {h: object[], v: object[]}, finishedAt: {h: number|null, v: number|null}}}
 */
export function runSchedule(actionsByChannel, macros, blockTimes, report) {
  const segments = { h: [], v: [] };
  const channels = Object.fromEntries(CHANNELS.map((channel) => [channel, {
    index: 0, // next action to run
    busyUntil: null, // end time of the current work, or null when free
    blocked: null, // { action, since } while waiting at a barrier / macro wait
    finishedAt: null, // when the last action completed
  }]));
  let now = 0;
  let writesThisInstant = new Map(); // variable -> last write at the current time

  /** End a channel's wait at `now` and record it. */
  const finishWait = (channel) => {
    const state = channels[channel];
    const { action, since } = state.blocked;
    segments[channel].push({ blockId: action.blockId, start: since, end: now, type: 'wait', label: waitLabel(action) });
    blockTimes[action.blockId].duration += now - since;
    state.blocked = null;
    state.index += 1;
  };

  /** Run a channel until it is busy, blocked or out of actions. @returns {boolean} whether anything happened */
  const advance = (channel) => {
    const state = channels[channel];
    if (state.busyUntil !== null || state.blocked) return false;
    const actions = actionsByChannel[channel];
    let progressed = false;

    while (state.index < actions.length) {
      const action = actions[state.index];
      progressed = true;
      if (action.kind === 'time') {
        segments[channel].push({ blockId: action.blockId, start: now, end: now + action.duration, type: action.type, ...(action.label ? { label: action.label } : {}) });
        state.index += 1;
        if (action.duration > EPSILON) {
          state.busyUntil = now + action.duration;
          break;
        }
      } else if (action.kind === 'set') {
        checkSameInstantWrites(writesThisInstant, action, channel, report);
        writesThisInstant.set(action.variable, { channel, value: action.value, blockId: action.blockId });
        macros.set(action.variable, action.value);
        segments[channel].push({ blockId: action.blockId, start: now, end: now, type: 'signal', label: `#${action.variable}=${action.value}` });
        state.index += 1;
      } else {
        state.blocked = { action, since: now }; // barrier, macroWait or unknownWait
        break;
      }
    }
    if (state.index === actions.length && state.busyUntil === null && !state.blocked && state.finishedAt === null) state.finishedAt = now;
    return progressed;
  };

  let steps = 0;
  while (++steps < MAX_STEPS) {
    let progressed = false;
    for (const channel of CHANNELS) progressed = advance(channel) || progressed;

    // Check waits only after both channels' instant assignments have happened.
    for (const channel of CHANNELS) {
      const action = channels[channel].blocked?.action;
      if (action?.kind === 'macroWait' && macros.has(action.variable) && macros.get(action.variable) === action.value) {
        finishWait(channel);
        progressed = true;
      }
    }
    const hWait = channels.h.blocked?.action;
    const vWait = channels.v.blocked?.action;
    if (hWait?.kind === 'barrier' && vWait?.kind === 'barrier' && hWait.key === vWait.key && hWait.occurrence === vWait.occurrence) {
      finishWait('h');
      finishWait('v');
      progressed = true;
    }
    if (progressed) continue;

    // Nothing can happen right now: jump to the next moment a channel becomes free.
    const nextFree = CHANNELS.map((channel) => channels[channel].busyUntil).filter((time) => time !== null);
    if (nextFree.length) {
      now = Math.min(...nextFree);
      writesThisInstant = new Map();
      for (const channel of CHANNELS) {
        if (channels[channel].busyUntil !== null && channels[channel].busyUntil <= now + EPSILON) channels[channel].busyUntil = null;
      }
      continue;
    }

    if (channels.h.finishedAt !== null && channels.v.finishedAt !== null) break; // both done
    reportStall(channels, macros, segments, blockTimes, now, report);
    break;
  }
  if (steps >= MAX_STEPS) {
    report.markIncomplete();
    report.warn('schedule-limit', 'The estimate exceeded its scheduling event limit.', [], 'error');
  }

  return { now, segments, finishedAt: { h: channels.h.finishedAt, v: channels.v.finishedAt } };
}

/**
 * Two different values written to one variable at the same instant: a wait may
 * never see the first one, and across channels the order is uncertain.
 */
function checkSameInstantWrites(writesThisInstant, action, channel, report) {
  const previous = writesThisInstant.get(action.variable);
  if (!previous || previous.value === action.value) return;
  const crossChannel = previous.channel !== channel;
  const detail = crossChannel
    ? 'Channel execution order is uncertain; this schedule uses horizontal then vertical.'
    : 'An earlier value is overwritten before any modeled time passes; a waiting channel may miss it.';
  report.warn(crossChannel ? 'concurrent-macro-write' : 'transient-macro-value', `#${action.variable} receives different values at the same estimated time. ${detail}`, [previous.blockId, action.blockId]);
  if (crossChannel) report.markIncomplete();
}

/** Nothing can run but a channel is still waiting: the programs deadlock here. */
function reportStall(channels, macros, segments, blockTimes, now, report) {
  report.markIncomplete();
  for (const channel of CHANNELS) {
    const waiting = channels[channel].blocked;
    if (!waiting) continue;
    const { action } = waiting;
    const name = channel === 'h' ? 'Horizontal' : 'Vertical';
    const message = action.kind === 'barrier'
      ? `${name} is blocked at barrier ${action.key}, occurrence ${action.occurrence}; the other channel cannot reach its matching occurrence.`
      : `${name} is blocked waiting for #${action.variable}=${action.value}; current value is ${macros.has(action.variable) ? macros.get(action.variable) : 'unknown'}, with no remaining runnable release.`;
    report.warn('synchronization-stalled', message, [action.blockId], 'error');
    // Keep the known part of the unfinished wait, without inventing an end time.
    segments[channel].push({ blockId: action.blockId, start: waiting.since, end: now, type: 'wait', label: 'Unresolved wait (shown through estimated horizon)' });
    blockTimes[action.blockId].duration += now - waiting.since;
  }
}

function waitLabel(action) {
  return action.kind === 'barrier' ? `Barrier ${action.key} · occurrence ${action.occurrence}` : `Wait for #${action.variable}=${action.value}`;
}
