/**
 * Totals per channel and "is at least one spindle cutting?" statistics.
 *
 * The goal of arranging wait codes is to keep a spindle cutting as much of the
 * cycle as possible. `coverage.utilization` is the fraction of the cycle in
 * which at least one channel is cutting; overlapping cuts count once.
 */
import { EPSILON } from './motion.js';

const CHANNELS = ['h', 'v'];

/**
 * Add idle-after-finish segments and total each channel's time.
 * @returns {{h: object, v: object}} per channel: { cut, air, toolChange, wait, total, utilization }
 */
export function channelTotals(segments, finishedAt, cycleEnd) {
  const totals = {};
  for (const channel of CHANNELS) {
    const finished = finishedAt[channel];
    if (finished !== null && finished < cycleEnd - EPSILON) {
      // A channel that finishes early sits idle until the other one is done.
      segments[channel].push({ blockId: `${channel}-end-idle`, start: finished, end: cycleEnd, type: 'wait', label: 'Idle after channel completes' });
    }
    const sums = { cut: 0, air: 0, toolChange: 0, wait: 0, total: cycleEnd, utilization: 0 };
    for (const segment of segments[channel]) if (segment.type in sums) sums[segment.type] += segment.end - segment.start;
    sums.utilization = cycleEnd > 0 ? sums.cut / cycleEnd : 0;
    totals[channel] = sums;
  }
  return totals;
}

/**
 * @returns {{cutting: number, nonCutting: number, simultaneous: number, utilization: number}}
 *   cutting       seconds with at least one channel cutting
 *   nonCutting    seconds with neither channel cutting
 *   simultaneous  seconds with both channels cutting
 */
export function cuttingCoverage(segments, cycleEnd) {
  const cuts = {};
  for (const channel of CHANNELS) {
    cuts[channel] = mergeIntervals(segments[channel]
      .filter((segment) => segment.type === 'cut')
      .map((segment) => [Math.max(0, segment.start), Math.min(cycleEnd, segment.end)])
      .filter(([start, end]) => end > start));
  }

  const either = mergeIntervals([...cuts.h, ...cuts.v].map((interval) => [...interval]));
  const cutting = Math.min(cycleEnd, either.reduce((sum, [start, end]) => sum + end - start, 0));

  // Walk both sorted lists together to add up the overlap.
  let simultaneous = 0;
  let hi = 0;
  let vi = 0;
  while (hi < cuts.h.length && vi < cuts.v.length) {
    const [hStart, hEnd] = cuts.h[hi];
    const [vStart, vEnd] = cuts.v[vi];
    simultaneous += Math.max(0, Math.min(hEnd, vEnd) - Math.max(hStart, vStart));
    if (hEnd <= vEnd) hi += 1;
    else vi += 1;
  }

  return { cutting, nonCutting: Math.max(0, cycleEnd - cutting), simultaneous, utilization: cycleEnd > 0 ? cutting / cycleEnd : 0 };
}

/** Sort [start, end] intervals and merge overlapping ones. Mutates the input pairs. */
function mergeIntervals(intervals) {
  const merged = [];
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
