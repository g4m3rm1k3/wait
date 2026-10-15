/**
 * Command-time estimate only. This does not model acceleration, contact,
 * machine interlocks, coordinate transforms, or collision safety.
 * All returned times are seconds; utilization is a fraction from 0 to 1.
 */
const DEFAULTS = { cutFeed: 600, rapidFeed: 10000, toolChangeSeconds: 8, rotationFeed: 180, initialMacros: {}, useProgramFeed: true };
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const SIMPLE_ASSIGNMENT = new RegExp(`^#(\\d+)\\s*=\\s*(${NUMBER})$`, 'i');
const SIMPLE_WAIT = new RegExp(`^WHILE\\s*\\[\\s*#(\\d+)\\s*NE\\s*(${NUMBER})\\s*\\]\\s*DO(\\d+)\\s+END\\3$`, 'i');
const EPSILON = 1e-9;

function commentsRemoved(source) {
  let depth = 0;
  return String(source ?? '').split(/\r\n|\r|\n/).map(line => {
    let result = '';
    for (const ch of line) {
      if (ch === '(') { depth++; continue; }
      if (ch === ')' && depth) { depth--; continue; }
      if (ch === ';' && !depth) break;
      if (!depth) result += ch;
    }
    return result.trim().toUpperCase();
  });
}

function finiteSetting(value, fallback, zeroAllowed = false) {
  const n = Number(value);
  return Number.isFinite(n) && (zeroAllowed ? n >= 0 : n > 0) ? n : fallback;
}

function macroNumber(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    if (Number.isInteger(value)) return Number.isSafeInteger(value) ? value : undefined;
    return Number(value.toPrecision(15)) === value ? value : undefined;
  }
  const literal = String(value ?? '').trim();
  if (!new RegExp(`^${NUMBER}$`).test(literal)) return undefined;
  const n = Number(literal);
  if (!Number.isFinite(n)) return undefined;
  const unsigned = literal.replace(/^[+-]/, '');
  const [integer, rawFraction = ''] = unsigned.split('.');
  const fraction = rawFraction.replace(/0+$/, '');
  const significantDigits = `${integer}${fraction}`.replace(/^0+/, '');
  // Preserve distinct source literals: JavaScript must not round either one
  // into a matching synchronization value. These are planning bounds, not a
  // claim about the controller's supported variable precision.
  if (fraction && (significantDigits.length > 15 || (n === 0 && significantDigits))) return undefined;
  if (Number.isInteger(n) && !Number.isSafeInteger(n)) return undefined;
  return n;
}

function variableKey(variable) { return String(variable ?? '').replace(/^#/, '').trim(); }

/** Estimate motion and run a two-channel event schedule without changing NC text. */
export function estimateCycle(hBlocks = [], vBlocks = [], config = {}, overrides = {}) {
  const settings = {
    ...DEFAULTS, ...config,
    cutFeed: finiteSetting(config.cutFeed, DEFAULTS.cutFeed),
    rapidFeed: finiteSetting(config.rapidFeed, DEFAULTS.rapidFeed),
    rotationFeed: finiteSetting(config.rotationFeed, DEFAULTS.rotationFeed),
    toolChangeSeconds: finiteSetting(config.toolChangeSeconds, DEFAULTS.toolChangeSeconds, true),
  };
  const diagnostics = [];
  const blockTimes = {};
  const diagnosticKeys = new Set();
  let complete = true;
  const warn = (code, message, blockIds = [], level = 'warning') => {
    const key = `${code}:${blockIds.join(',')}:${message}`;
    if (diagnosticKeys.has(key)) return;
    diagnosticKeys.add(key);
    diagnostics.push({ level, code, message, ...(blockIds.length ? { blockIds } : {}) });
  };
  const actionsByChannel = {};

  for (const [channel, blocks] of Object.entries({ h: hBlocks, v: vBlocks })) {
    const modal = { units: 1, absolute: true, motion: null, feed: null, feedMode: 94, position: { X: 0, Y: 0, Z: 0, B: 0 } };
    const barrierOccurrences = new Map();
    let originNotice = false;
    let programEnded = false;
    const allActions = [];
    for (const [blockIndex, block] of blocks.entries()) {
      const id = String(block.id ?? `${channel}-${blockIndex}`);
      const actions = [];
      const unknownMessages = [];
      const unknown = (message) => { unknownMessages.push(message); actions.push({ kind: 'time', type: 'unknown', duration: 0, blockId: id, label: message }); };
      const time = (duration, type, label) => {
        if (!Number.isFinite(duration)) unknown('Travel duration exceeds the numeric range of the estimate.');
        else if (duration > EPSILON) actions.push({ kind: 'time', duration, type, blockId: id, ...(label ? { label } : {}) });
      };
      const synchronization = sync => {
        if (sync.kind === 'barrier' || sync.role === 'barrier') {
          const key = String(sync.key);
          const occurrence = (barrierOccurrences.get(key) ?? 0) + 1;
          barrierOccurrences.set(key, occurrence);
          actions.push({ kind: 'barrier', key, occurrence, blockId: id });
        } else {
          const variable = variableKey(sync.variable);
          const value = macroNumber(sync.value);
          if (!/^\d+$/.test(variable) || value === undefined) {
            unknown('Macro synchronization requires a finite literal within the estimator precision bounds: safe integers, or decimals with at most 15 significant digits.');
            if (sync.role !== 'signal') actions.push({ kind: 'unknownWait', variable, value: String(sync.value), blockId: id });
            return;
          }
          actions.push({ kind: sync.role === 'signal' ? 'set' : 'macroWait', variable, value, blockId: id });
        }
      };
      const cleanLines = commentsRemoved(block.text ?? block.source ?? '');
      const cleanText = cleanLines.filter(Boolean).join('\n');
      const hasExecutableTail = lines => lines.some(raw => {
        const line = raw.replace(/^\s*N\d+\s*/, '').trim();
        return line && line !== '%' && !/^O\s*\d+$/.test(line);
      });
      const ignoredTail = () => {
        complete = false;
        warn('after-program-end', 'Executable code after M2/M30 is ignored by this channel estimate. Move intended operations before the program end.', [id]);
      };
      if (programEnded) {
        if (hasExecutableTail(cleanLines) || block.sync) ignoredTail();
        blockTimes[id] = { duration: 0, cut: 0, air: 0, toolChange: 0 };
        continue;
      }
      const simpleWait = SIMPLE_WAIT.exec(cleanText);
      if (block.sync) {
        synchronization(block.sync);
        if (block.sync.kind === 'barrier' && block.sync.code) {
          const remainder = cleanText.replace(String(block.sync.code).toUpperCase(), '').replace(/^N\d+\s*/, '').trim();
          if (remainder) unknown('This barrier shares a line with executable code; its motion and execution order require separate lines before they can be timed.');
        }
        if ([...cleanText.matchAll(/M\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g)].some(match => [2, 30].includes(Number(match[1])))) programEnded = true;
      }
      else if (simpleWait) synchronization({ kind: 'macro', role: 'wait', variable: simpleWait[1], value: simpleWait[2] });
      else for (let line of cleanLines) {
        line = line.replace(/^\s*N\d+\s*/, '').trim();
        if (!line || line === '%' || /^O\d+$/.test(line)) continue;
        if (programEnded) { ignoredTail(); continue; }
        const assignment = SIMPLE_ASSIGNMENT.exec(line);
        if (assignment) { synchronization({ kind: 'macro', role: 'signal', variable: assignment[1], value: assignment[2] }); continue; }
        if (/\b(?:IF|WHILE|GOTO|DO\d*|END\d*)\b|#|\[|\]|^\//.test(line)) {
          unknown(`Control flow, macro expressions, or optional execution cannot be timed automatically: ${line}`);
          continue;
        }
        const words = [...line.matchAll(/([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g)].map(match => ({ letter: match[1], value: Number(match[2]), text: match[0] }));
        const remainder = line.replace(/([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g, '').replace(/\s/g, '');
        if (remainder || !words.length) { unknown(`Unrecognized instruction cannot be timed automatically: ${line}`); continue; }
        if (words.some(word => !Number.isFinite(word.value))) { unknown('An instruction contains a number outside the supported numeric range.'); continue; }
        const gCodes = words.filter(word => word.letter === 'G').map(word => word.value);
        const mCodes = words.filter(word => word.letter === 'M').map(word => word.value);
        if (mCodes.some(code => code === 2 || code === 30)) programEnded = true;
        if (gCodes.includes(20)) modal.units = 25.4;
        if (gCodes.includes(21)) modal.units = 1;
        if (gCodes.includes(90)) modal.absolute = true;
        if (gCodes.includes(91)) modal.absolute = false;
        for (const feedMode of [93, 94, 95]) if (gCodes.includes(feedMode)) modal.feedMode = feedMode;
        for (const word of words) if (word.letter === 'F') modal.feed = word.value;
        for (const code of gCodes) if ([0, 1, 2, 3].includes(code)) modal.motion = code;
        for (const code of mCodes) {
          if (code === 6) time(settings.toolChangeSeconds, 'toolChange', 'Tool change');
          else if (![2, 3, 4, 5, 8, 9, 30].includes(code)) unknown(`M${code} has no configured time or execution model.`);
        }
        const knownG = new Set([0, 1, 2, 3, 17, 18, 19, 20, 21, 40, 43, 49, 54, 55, 56, 57, 58, 59, 61, 64, 80, 90, 91, 93, 94, 95, 96, 97, 98, 99]);
        const opaqueG = gCodes.filter(code => !knownG.has(code));
        if (opaqueG.length) {
          unknown(`${opaqueG.map(code => `G${code}`).join(', ')} is not included in the straight-line timing model.`);
          // An unmodeled move or frame change also makes the following starting position unknown.
          if (opaqueG.some(code => code !== 4)) {
            const affectedAxes = opaqueG.every(code => [68, 69].includes(code)) ? ['X', 'Y', 'Z'] : ['X', 'Y', 'Z', 'B'];
            for (const axis of affectedAxes) modal.position[axis] = null;
          }
          continue;
        }
        if (words.some(word => !'GMXYZBFSHTDPLQRIJK'.includes(word.letter))) unknown(`An unsupported axis or word appears in: ${line}`);
        const axes = words.filter(word => 'XYZB'.includes(word.letter));
        if (!axes.length) {
          if ((modal.motion === 2 || modal.motion === 3) && words.some(word => 'IJKR'.includes(word.letter))) unknown('Arc motion (including full circles) requires a manual block time.');
          continue;
        }
        const next = { ...modal.position };
        let xyzSquared = 0;
        let rotation = 0;
        let unknownPosition = false;
        for (const { letter: axis, value } of axes) {
          const coordinate = value * (axis === 'B' ? 1 : modal.units);
          const from = modal.position[axis];
          const to = modal.absolute ? coordinate : from === null ? null : from + coordinate;
          next[axis] = to;
          if (from === null || to === null) unknownPosition = true;
          else if (axis === 'B') rotation = Math.abs(to - from);
          else xyzSquared += (to - from) ** 2;
        }
        modal.position = next;
        if (!originNotice) {
          warn('initial-position-assumed', `${channel === 'h' ? 'Horizontal' : 'Vertical'} motion starts from assumed X0 Y0 Z0 B0; enter manual block times where the actual starting position differs.`, [id], 'info');
          originNotice = true;
        }
        if (axes.some((word, index) => axes.findIndex(other => other.letter === word.letter) !== index)) { unknown('Repeated axis words on one line are not modeled.'); continue; }
        if (unknownPosition) { unknown('Travel begins at an unknown position after an unmodeled instruction.'); continue; }
        if (modal.motion === 2 || modal.motion === 3) { unknown('Arc motion (including modal G2/G3) requires a manual block time.'); continue; }
        if (modal.motion === null) { unknown('Axis words have no known G0/G1 motion mode.'); continue; }
        if (modal.motion === 1 && modal.feedMode !== 94) { unknown(`G${modal.feedMode} feed timing requires a manual block time.`); continue; }
        const distance = Math.sqrt(xyzSquared);
        const feed = modal.motion === 0 ? settings.rapidFeed : settings.useProgramFeed && modal.feed !== null ? modal.feed * modal.units : settings.cutFeed;
        if (!(feed > 0)) { unknown('A positive feed rate is required to estimate this move.'); continue; }
        const duration = Math.max(distance / feed, rotation / settings.rotationFeed) * 60;
        time(duration, modal.motion === 1 && distance > EPSILON ? 'cut' : 'air', rotation > 0 ? 'Move with B-axis rotation' : undefined);
      }

      const rawOverride = overrides[id];
      const manual = rawOverride !== '' && rawOverride !== null && rawOverride !== undefined ? Number(rawOverride) : NaN;
      const hasOverride = Number.isFinite(manual) && manual >= 0;
      let finalActions = actions;
      if (hasOverride && !block.sync && !simpleWait) {
        const sum = type => actions.filter(action => action.type === type).reduce((total, action) => total + action.duration, 0);
        const dominant = block.flags?.toolChange || sum('toolChange') > Math.max(sum('cut'), sum('air')) ? 'toolChange' : sum('cut') > 0 ? 'cut' : block.flags?.rotation || sum('air') > 0 ? 'air' : /G0*[123](?=[A-Z\s]|$)/i.test(cleanText) ? 'cut' : 'air';
        const replacement = { kind: 'time', duration: manual, type: dominant, blockId: id, label: 'Manual block time' };
        let inserted = false;
        finalActions = [];
        for (const action of actions) {
          if (action.kind === 'time') { if (!inserted) { finalActions.push(replacement); inserted = true; } }
          else finalActions.push(action);
        }
        if (!inserted) finalActions.unshift(replacement);
      } else if (rawOverride !== undefined && !hasOverride) warn('invalid-override', 'Manual block time must be a non-negative number of seconds.', [id]);

      const unresolved = finalActions.some(action => action.type === 'unknown');
      blockTimes[id] = { duration: 0, cut: 0, air: 0, toolChange: 0, ...(unresolved ? { unknown: true } : {}) };
      for (const action of finalActions) if (action.kind === 'time') {
        blockTimes[id].duration += action.duration;
        if (['cut', 'air', 'toolChange'].includes(action.type)) blockTimes[id][action.type] += action.duration;
      }
      if (unresolved) {
        complete = false;
        warn('unknown-block-time', `Enter a manual time for this block. ${[...new Set(unknownMessages)].join(' ')}`, [id]);
      }
      allActions.push(...finalActions);
    }
    actionsByChannel[channel] = allActions;
  }

  const macros = new Map();
  for (const [key, value] of Object.entries(settings.initialMacros ?? {})) {
    const n = macroNumber(value);
    if (n !== undefined) macros.set(variableKey(key), n);
    else {
      complete = false;
      warn('unsupported-initial-macro', `Initial #${variableKey(key)} is outside the supported macro precision bounds or is not a finite literal; its value remains unknown.`);
    }
  }
  const segments = { h: [], v: [] };
  const state = Object.fromEntries(['h', 'v'].map(channel => [channel, { index: 0, busyUntil: null, blocked: null, finishedAt: null }]));
  let now = 0;
  let steps = 0;
  let writesAtThisTime = new Map();
  const finishWait = channel => {
    const s = state[channel];
    const wait = s.blocked;
    if (!wait) return;
    segments[channel].push({ blockId: wait.action.blockId, start: wait.since, end: now, type: 'wait', label: wait.action.kind === 'barrier' ? `Barrier ${wait.action.key} · occurrence ${wait.action.occurrence}` : `Wait for #${wait.action.variable}=${wait.action.value}` });
    blockTimes[wait.action.blockId].duration += now - wait.since;
    s.blocked = null;
    s.index++;
  };

  while (++steps < 100000) {
    let progressed = false;
    for (const channel of ['h', 'v']) {
      const s = state[channel];
      if (s.busyUntil !== null || s.blocked) continue;
      const actions = actionsByChannel[channel];
      while (s.index < actions.length) {
        const action = actions[s.index];
        if (action.kind === 'time') {
          segments[channel].push({ blockId: action.blockId, start: now, end: now + action.duration, type: action.type, ...(action.label ? { label: action.label } : {}) });
          s.index++;
          progressed = true;
          if (action.duration > EPSILON) { s.busyUntil = now + action.duration; break; }
        } else if (action.kind === 'set') {
          const previousWrite = writesAtThisTime.get(action.variable);
          if (previousWrite && previousWrite.value !== action.value) {
            const crossChannel = previousWrite.channel !== channel;
            warn(crossChannel ? 'concurrent-macro-write' : 'transient-macro-value', `#${action.variable} receives different values at the same estimated time. ${crossChannel ? 'Channel execution order is uncertain; this schedule uses horizontal then vertical.' : 'An earlier value is overwritten before any modeled time passes; a waiting channel may miss it.'}`, [previousWrite.blockId, action.blockId]);
            if (crossChannel) complete = false;
          }
          writesAtThisTime.set(action.variable, { channel, value: action.value, blockId: action.blockId });
          macros.set(action.variable, action.value);
          segments[channel].push({ blockId: action.blockId, start: now, end: now, type: 'signal', label: `#${action.variable}=${action.value}` });
          s.index++;
          progressed = true;
        } else {
          s.blocked = { action, since: now };
          progressed = true;
          break;
        }
      }
      if (s.index === actions.length && s.busyUntil === null && !s.blocked && s.finishedAt === null) s.finishedAt = now;
    }

    // Evaluate waits only after both channels' zero-time writes have settled.
    const releasingMacros = ['h', 'v'].filter(channel => {
      const action = state[channel].blocked?.action;
      return action?.kind === 'macroWait' && macros.has(action.variable) && macros.get(action.variable) === action.value;
    });
    for (const channel of releasingMacros) { finishWait(channel); progressed = true; }
    const hBarrier = state.h.blocked?.action;
    const vBarrier = state.v.blocked?.action;
    if (hBarrier?.kind === 'barrier' && vBarrier?.kind === 'barrier' && hBarrier.key === vBarrier.key && hBarrier.occurrence === vBarrier.occurrence) {
      finishWait('h'); finishWait('v'); progressed = true;
    }
    if (progressed) continue;
    const nextEnds = ['h', 'v'].map(channel => state[channel].busyUntil).filter(value => value !== null);
    if (nextEnds.length) {
      now = Math.min(...nextEnds);
      writesAtThisTime = new Map();
      for (const channel of ['h', 'v']) if (state[channel].busyUntil !== null && state[channel].busyUntil <= now + EPSILON) state[channel].busyUntil = null;
      continue;
    }
    if (state.h.finishedAt !== null && state.v.finishedAt !== null) break;
    complete = false;
    for (const channel of ['h', 'v']) {
      const waiting = state[channel].blocked;
      if (!waiting) continue;
      const action = waiting.action;
      warn('synchronization-stalled', action.kind === 'barrier'
        ? `${channel === 'h' ? 'Horizontal' : 'Vertical'} is blocked at barrier ${action.key}, occurrence ${action.occurrence}; the other channel cannot reach its matching occurrence.`
        : `${channel === 'h' ? 'Horizontal' : 'Vertical'} is blocked waiting for #${action.variable}=${action.value}; current value is ${macros.has(action.variable) ? macros.get(action.variable) : 'unknown'}, with no remaining runnable release.`, [action.blockId], 'error');
      // Retain the known part of an unfinished wait, without inventing an end time.
      segments[channel].push({ blockId: action.blockId, start: waiting.since, end: now, type: 'wait', label: 'Unresolved wait (shown through estimated horizon)' });
      blockTimes[action.blockId].duration += now - waiting.since;
    }
    break;
  }
  if (steps >= 100000) { complete = false; warn('schedule-limit', 'The estimate exceeded its scheduling event limit.', [], 'error'); }

  const channels = {};
  for (const channel of ['h', 'v']) {
    const finished = state[channel].finishedAt;
    if (finished !== null && finished < now - EPSILON) segments[channel].push({ blockId: `${channel}-end-idle`, start: finished, end: now, type: 'wait', label: 'Idle after channel completes' });
    const totals = { cut: 0, air: 0, toolChange: 0, wait: 0, total: now, utilization: 0 };
    for (const segment of segments[channel]) if (segment.type in totals) totals[segment.type] += segment.end - segment.start;
    totals.utilization = now > 0 ? totals.cut / now : 0;
    channels[channel] = totals;
  }
  const mergeCutIntervals = intervals => {
    const merged = [];
    for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
      const previous = merged.at(-1);
      if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
      else merged.push([start, end]);
    }
    return merged;
  };
  const cutIntervals = Object.fromEntries(['h', 'v'].map(channel => [channel, mergeCutIntervals(segments[channel]
    .filter(segment => segment.type === 'cut')
    .map(segment => [Math.max(0, segment.start), Math.min(now, segment.end)])
    .filter(([start, end]) => end > start))]));
  const union = mergeCutIntervals([...cutIntervals.h, ...cutIntervals.v].map(interval => [...interval]));
  const cutting = Math.min(now, union.reduce((total, [start, end]) => total + end - start, 0));
  let simultaneous = 0;
  let hi = 0;
  let vi = 0;
  while (hi < cutIntervals.h.length && vi < cutIntervals.v.length) {
    const horizontal = cutIntervals.h[hi];
    const vertical = cutIntervals.v[vi];
    simultaneous += Math.max(0, Math.min(horizontal[1], vertical[1]) - Math.max(horizontal[0], vertical[0]));
    if (horizontal[1] <= vertical[1]) hi++;
    else vi++;
  }
  const coverage = { cutting, nonCutting: Math.max(0, now - cutting), simultaneous, utilization: now > 0 ? cutting / now : 0 };
  return { duration: now, channels, segments, blockTimes, diagnostics, coverage, complete };
}
