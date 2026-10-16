/**
 * JavaScript copy of tools/sync_plan.py, line for line, for the tutorial.
 * tests/tutorial-planner.test.js checks it against the Python's reference
 * outputs (tools/conformance), so the tutorial cannot teach something the
 * Python does not do.
 *
 * planV() also records every step it takes (`steps`) so the page can replay it.
 */

export const DEFAULT_SETTINGS = {
  SAFETY_SECONDS: 6,
  ROTATE_LOCKOUT_SECONDS: 4,
  TOOL_CHANGE_LOCKOUT_SECONDS: 10,
  V_TOOL_CHANGE_SECONDS: 8,
  START_IS_B_EVENT: true,
};

const LINE = /^\s*(\S+?)_2([HV])\s+(\d)(\d)(\d{3})\s*:=\s*(\d+):(\d+(?:\.\d+)?)\s*$/i;

/** 1. Parse:  FAM_2H 12002 := 00:35  ->  {spindle, offset, rotation, tool, seconds} */
export function parseOps(text, settings) {
  const h = [];
  const v = [];
  const errors = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (!raw.trim()) return;
    const m = raw.match(LINE);
    if (!m) {
      errors.push(`Line ${index + 1} not recognized: ${raw}`);
      return;
    }
    const op = {
      text: raw.trim(),
      spindle: m[2].toUpperCase(),
      offset: Number(m[3]),
      rotation: Number(m[4]),
      tool: Number(m[5]),
      seconds: Number(m[6]) * 60 + Number(m[7]) + settings.SAFETY_SECONDS,
    };
    (op.spindle === 'H' ? h : v).push(op);
  });
  return { h, v, errors };
}

/** Lockout seconds for the B event before `op`, or null if there is none. */
export function eventLockout(prev, op, settings) {
  if (!prev) return settings.START_IS_B_EVENT ? settings.TOOL_CHANGE_LOCKOUT_SECONDS : null;
  if (prev.tool !== op.tool) return settings.TOOL_CHANGE_LOCKOUT_SECONDS;
  if (prev.rotation !== op.rotation) return settings.ROTATE_LOCKOUT_SECONDS;
  return null;
}

/** 2. Cut H into stretches: a new stretch at every B event. */
export function hStretches(h, settings) {
  const stretches = [];
  h.forEach((op, i) => {
    const lockout = eventLockout(i ? h[i - 1] : null, op, settings);
    const isEvent = lockout !== null;
    if (!stretches.length || isEvent) stretches.push({ ops: [], seconds: 0, event: isEvent, lockout: lockout || 0 });
    stretches[stretches.length - 1].ops.push(op);
    stretches[stretches.length - 1].seconds += op.seconds;
  });
  return stretches;
}

/** Seconds of V op i's time that are a tool change (0 if same tool as op i-1). */
export function vToolChange(v, i, settings) {
  if (i > 0 && v[i].tool === v[i - 1].tool) return 0;
  return Math.min(settings.V_TOOL_CHANGE_SECONDS, v[i].seconds);
}

/** pre = V's first tool change; piece j = op j's cutting + the next op's tool change. */
export function vPieces(v, settings) {
  const tcs = v.map((_, j) => vToolChange(v, j, settings));
  const pre = v.length ? tcs[0] : 0;
  const pieces = v.map((op, j) => op.seconds - tcs[j] + (j + 1 < v.length ? tcs[j + 1] : 0));
  return { pre, pieces, tcs };
}

/** [when V starts cutting, stretch cost], both from the start of stretch s. */
export function stretchTiming(s, stretch, w, pre) {
  if (s === 0 && !stretch.event) return [pre, Math.max(stretch.seconds, pre + w)];
  const lead = s === 0 ? pre : 0;
  return [lead + stretch.lockout, lead + Math.max(stretch.seconds, stretch.lockout + w)];
}

/** 3. Try every split of V's pieces; best[s][j] = shortest time for stretches 0..s-1 with pieces 0..j-1. */
export function planV(stretches, v, settings) {
  const S = stretches.length;
  const n = v.length;
  const { pre, pieces } = vPieces(v, settings);
  const prefix = [0];
  for (const w of pieces) prefix.push(prefix[prefix.length - 1] + w);

  const best = Array.from({ length: S + 1 }, () => new Array(n + 1).fill(Infinity));
  const from = Array.from({ length: S + 1 }, () => new Array(n + 1).fill(null));
  best[0][0] = 0;
  const steps = [];

  for (let s = 1; s <= S; s++) {
    const stretch = stretches[s - 1];
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= j; i++) {
        if (best[s - 1][i] === Infinity) {
          steps.push({ kind: 'skip', s, j, i });
          continue;
        }
        const w = prefix[j] - prefix[i];
        const [, cost] = stretchTiming(s - 1, stretch, w, pre);
        const total = best[s - 1][i] + cost;
        const before = best[s][j];
        const better = total < before; // "<" keeps the earliest split on ties
        if (better) {
          best[s][j] = total;
          from[s][j] = i;
        }
        steps.push({ kind: 'try', s, j, i, w, cost, total, before, better });
      }
    }
  }

  const groups = new Array(S);
  const cuts = [];
  let j = n;
  for (let s = S; s >= 1; s--) {
    const i = from[s][j];
    groups[s - 1] = v.slice(i, j);
    cuts.unshift([i, j]);
    j = i;
  }
  return { groups, cuts, cycle: best[S][n], best, from, steps, pre, pieces };
}

/** Python's "{:.0f}" rounds halves to even; match it exactly. */
function fixed0(x) {
  const r = Math.round(x);
  return String(Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r);
}
const pad = (text, width, right = true) => (right ? String(text).padStart(width) : String(text).padEnd(width));

/** 4. Same text as sync_plan.timeline(), plus the numbers for drawing it. */
export function timeline(stretches, groups, v, settings) {
  const { pre, pieces } = vPieces(v, settings);
  const lines = [];
  const rows = [];
  let t = 0;
  let firstV = 0;
  stretches.forEach((stretch, s) => {
    const n = groups[s].length;
    const w = pieces.slice(firstV, firstV + n).reduce((a, b) => a + b, 0);
    const [vStart, cost] = stretchTiming(s, stretch, w, pre);
    const kind = s === 0 && !stretch.event ? 'start'
      : stretch.lockout === settings.TOOL_CHANGE_LOCKOUT_SECONDS ? 'tool change' : 'rotation';
    const hTools = stretch.ops.map((op) => `T${op.tool}`).join('/');
    let vText = 'V nothing to cut';
    if (n) {
      const ops = n === 1 ? `op ${firstV + 1}` : `ops ${firstV + 1}-${firstV + n}`;
      vText = `V ${ops} ${fixed0(t + vStart)}-${fixed0(t + vStart + w)}s`;
    }
    lines.push(`${pad(s + 1, 2)}. ${pad(fixed0(t), 6)}s ${pad(kind, 11, false)} H ${pad(hTools, 8, false)} ${pad(fixed0(stretch.seconds), 4)}s | ${vText} | H waits ${fixed0(cost - stretch.seconds)}s`);
    const lead = s === 0 && stretch.event ? pre : 0;
    rows.push({ s, t, kind, lead, lockout: stretch.event ? stretch.lockout : 0, hSeconds: stretch.seconds, vStart, w, cost, firstV, n, hTools });
    t += cost;
    firstV += n;
  });
  lines.push(`    ${pad(fixed0(t), 6)}s end of cycle  (V times include the tool change for its next op)`);
  return { lines, rows, end: t };
}

/** The marked-up list, as sync_plan.render() writes it. */
export function render(stretches, groups, cycle) {
  const hLines = [];
  const vLines = [];
  let hTotal = 0;
  let vTotal = 0;
  stretches.forEach((stretch, s) => {
    if (stretch.event) {
      hLines.push('(WAIT BEFORE)', '(WAIT AFTER)');
      vLines.push('(WAIT)');
    }
    for (const op of stretch.ops) { hLines.push(op.text); hTotal += op.seconds; }
    for (const op of groups[s]) { vLines.push(op.text); vTotal += op.seconds; }
  });
  const f = (x) => x.toFixed(1);
  return [...hLines, ...vLines, `(EST CYCLE ${f(cycle)}S  H IDLE ${f(cycle - hTotal)}S  V IDLE ${f(cycle - vTotal)}S)`];
}

/** Everything at once, for the page. */
export function planAll(text, settings = DEFAULT_SETTINGS) {
  const { h, v, errors } = parseOps(text, settings);
  if (errors.length) return { errors };
  if (!h.length) return { errors: ['No H operations found; nothing to sync.'] };
  const stretches = hStretches(h, settings);
  const plan = planV(stretches, v, settings);
  return { errors: [], h, v, stretches, plan, timeline: timeline(stretches, plan.groups, v, settings), marked: render(stretches, plan.groups, plan.cycle) };
}
