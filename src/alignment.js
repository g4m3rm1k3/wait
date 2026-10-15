/**
 * Align two source-ordered channels around synchronization statements.
 *
 * Rows are an editing aid, not an execution schedule. In particular a macro
 * assignment releases an opposite-channel equality wait without holding the
 * channel that made the assignment.
 */
export function alignChannels(horizontal = [], vertical = [], options = {}) {
  const hBlocks = Array.isArray(horizontal) ? horizontal : [];
  const vBlocks = Array.isArray(vertical) ? vertical : [];
  const diagnostics = [];
  const candidates = [];
  const barriers = new Map();
  const macros = new Map();
  const writers = new Map();

  const blockIds = (entries) => [...new Set(entries.map((entry) => entry.block.id).filter((id) => id != null))];
  const report = (level, code, message, entries = []) => {
    const ids = blockIds(entries);
    diagnostics.push({ level, code, message, ...(ids.length ? { blockIds: ids } : {}) });
  };

  function collect(blocks, channel) {
    blocks.forEach((block, index) => {
      const sync = block.sync;
      if (!sync) return;
      const entry = { block, index, channel, sync };
      if (sync.kind === 'barrier') {
        const key = String(sync.key ?? '').trim();
        if (!key) {
          report('warning', 'sync-unsupported', 'A barrier has no recognized matching key.', [entry]);
          return;
        }
        if (!barriers.has(key)) barriers.set(key, { h: [], v: [] });
        barriers.get(key)[channel].push(entry);
      } else if (sync.kind === 'macro') {
        if (!['signal', 'wait'].includes(sync.role)) {
          report('warning', 'macro-unsupported', 'A macro synchronization statement has an unsupported role.', [entry]);
          return;
        }
        const variable = normalizeVariable(sync.variable);
        const value = sync.value == null ? '' : normalizeValue(sync.value);
        const key = variable && value ? `#${variable}=${value}` : String(sync.key ?? '').replace(/\s+/g, '').toUpperCase();
        if (!key) {
          report('warning', 'macro-unsupported', 'A macro synchronization statement has no recognized variable/value key.', [entry]);
          return;
        }
        entry.variable = variable;
        entry.value = value;
        entry.key = key;
        if (!macros.has(key)) macros.set(key, { h: { signal: [], wait: [] }, v: { signal: [], wait: [] } });
        macros.get(key)[channel][sync.role].push(entry);
        if (sync.role === 'signal' && variable) {
          if (!writers.has(variable)) writers.set(variable, []);
          writers.get(variable).push(entry);
        }
      } else {
        report('warning', 'sync-unsupported', 'An unrecognized synchronization statement could not be aligned.', [entry]);
      }
    });
  }

  collect(hBlocks, 'h');
  collect(vBlocks, 'v');

  for (const [key, group] of barriers) {
    const count = Math.min(group.h.length, group.v.length);
    for (let i = 0; i < count; i += 1) {
      candidates.push(makePair(group.h[i], group.v[i], {
        key, kind: 'barrier', occurrence: i + 1,
        label: `WAIT ${key}${Math.max(group.h.length, group.v.length) > 1 ? ` · occurrence ${i + 1}` : ''}`,
      }));
    }
    for (const channel of ['h', 'v']) {
      group[channel].slice(count).forEach((entry, index) => {
        report('error', 'barrier-unmatched', `${channelName(channel)} barrier ${key} (occurrence ${count + index + 1}) has no opposite-channel partner. Check the wait pattern and participant setting.`, [entry]);
      });
    }
  }

  for (const [key, group] of macros) {
    for (const producer of ['h', 'v']) {
      const consumer = opposite(producer);
      const signals = group[producer].signal;
      const waits = group[consumer].wait;
      if (signals.length === 1 && waits.length === 1) {
        const signal = signals[0];
        const wait = waits[0];
        candidates.push(makePair(producer === 'h' ? signal : wait, producer === 'v' ? signal : wait, {
          key, kind: 'macro', signal, wait,
          label: `${key} · ${producer.toUpperCase()} → ${consumer.toUpperCase()}`,
        }));
      } else if (signals.length && waits.length) {
        report('warning', 'macro-ambiguous', `${key} has ${signals.length} ${channelName(producer).toLowerCase()} assignment(s) and ${waits.length} opposite-channel wait(s). Repeated values cannot be paired reliably from source alone; these statements were left unaligned.`, [...signals, ...waits]);
      } else if (waits.length) {
        report('warning', 'macro-unresolved-wait', `${channelName(consumer)} waits for ${key}, but no opposite-channel assignment was recognized. The value may depend on initial state or code outside this view.`, waits);
      } else if (signals.length) {
        report('info', 'macro-unused-signal', `${channelName(producer)} assigns ${key} with no recognized opposite-channel equality wait.`, signals);
      }
    }
  }

  const barrierPairs = candidates.filter((pair) => pair.kind === 'barrier').sort(byHorizontalIndex);
  let furthestBarrier = null;
  const crossed = [];
  for (const pair of barrierPairs) {
    if (furthestBarrier && pair.v.index < furthestBarrier.v.index) {
      crossed.push(pair.h, pair.v, furthestBarrier.h, furthestBarrier.v);
    }
    if (!furthestBarrier || pair.v.index > furthestBarrier.v.index) furthestBarrier = pair;
  }
  if (crossed.length) {
    report('error', 'sync-cycle', 'Barrier order is crossed between the channels. Each channel can reach a different barrier first and wait indefinitely. Source order has been preserved; conflicting barriers cannot share rows.', crossed);
  }

  const macroPairs = candidates.filter((pair) => pair.kind === 'macro');
  if (macros.size) {
    report('info', 'macro-static-only', 'Macro links show source dependencies only. Assignments do not hold the producing channel; initial values, execution timing, branching and machine interlocks are not established by this alignment.');
  }

  for (const [variable, entries] of writers) {
    if (new Set(entries.map((entry) => entry.channel)).size > 1) {
      report('warning', 'macro-multiple-writers', `Both channels write #${variable}. Shared values can be overwritten; review ownership and initial values.`, entries);
    }
  }

  if (options.warnMacroRaces !== false) {
    for (const pair of macroPairs) {
      const { signal, wait } = pair;
      if (!signal.variable) continue;
      const overwrites = (writers.get(signal.variable) ?? []).filter((entry) => {
        if (entry === signal || entry.channel !== signal.channel || entry.index <= signal.index) return false;
        // A rendezvous after the consumer's wait prevents the producer from
        // overwriting this signal until that wait has completed.
        return !barrierPairs.some((barrier) => {
          const producerBarrier = barrier[signal.channel];
          const consumerBarrier = barrier[wait.channel];
          return producerBarrier.index > signal.index && producerBarrier.index < entry.index && consumerBarrier.index > wait.index;
        });
      });
      if (overwrites.length) {
        report('warning', 'macro-equality-race', `${pair.key} can be overwritten by its producer before the opposite equality wait is known to have observed it. A missed value can leave the wait running indefinitely.`, [signal, wait, ...overwrites]);
      }
    }
  }

  findMacroDependencyCycles(hBlocks, vBlocks, barrierPairs, macroPairs).forEach((entries) => {
    report('warning', 'macro-dependency-cycle', 'Macro wait dependencies form a cycle in source order: a needed assignment is reached only after a wait that depends back on this channel. Review initial values and execution; this can deadlock.', entries);
  });

  const eligible = options.includeMacroAnchors === false ? barrierPairs : candidates;
  const anchors = monotoneAnchors(eligible, vBlocks.length);
  const aligned = new Set(anchors);
  for (const pair of macroPairs) {
    if (!aligned.has(pair) && options.includeMacroAnchors !== false) {
      report('warning', 'macro-visual-conflict', `${pair.key} is linked across channels but cannot share a row without changing source order or displacing a barrier. Its directional dependency remains visible in the link.`, [pair.h, pair.v]);
    }
  }

  const rows = [];
  let hCursor = 0;
  let vCursor = 0;
  const addContentUntil = (hEnd, vEnd) => {
    while (hCursor < hEnd || vCursor < vEnd) {
      rows.push({ h: hCursor < hEnd ? hBlocks[hCursor++] : null, v: vCursor < vEnd ? vBlocks[vCursor++] : null, type: 'content' });
    }
  };
  for (const pair of anchors) {
    addContentUntil(pair.h.index, pair.v.index);
    rows.push({ h: pair.h.block, v: pair.v.block, key: pair.key, type: 'sync' });
    hCursor += 1;
    vCursor += 1;
  }
  addContentUntil(hBlocks.length, vBlocks.length);

  return {
    rows,
    links: candidates.map((pair) => ({
      key: pair.key, hId: pair.h.block.id, vId: pair.v.block.id,
      kind: pair.kind, label: pair.label, aligned: aligned.has(pair),
      ...(pair.kind === 'macro' ? { signalId: pair.signal.block.id, waitId: pair.wait.block.id, producer: pair.signal.channel } : {}),
    })),
    diagnostics,
    matchedCount: anchors.length,
  };
}

function normalizeVariable(value) {
  if (value == null) return '';
  const text = String(value).replace(/^#/, '').trim();
  return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, '') : text.toUpperCase();
}

function normalizeValue(value) {
  const text = String(value).replace(/\s+/g, '').toUpperCase();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return text;
  const negative = text.startsWith('-');
  const [whole = '', fraction = ''] = text.replace(/^[+-]/, '').split('.');
  const integer = whole.replace(/^0+(?=\d)/, '') || '0';
  const decimal = fraction.replace(/0+$/, '');
  const number = decimal ? `${integer}.${decimal}` : integer;
  return negative && number !== '0' ? `-${number}` : number;
}

function opposite(channel) { return channel === 'h' ? 'v' : 'h'; }
function channelName(channel) { return channel === 'h' ? 'Horizontal' : 'Vertical'; }
function makePair(h, v, details) { return { h, v, ...details }; }
function byHorizontalIndex(a, b) { return a.h.index - b.h.index || a.v.index - b.v.index; }

// Weighted increasing subsequence. Barriers take priority over macro anchors;
// then the greatest total number of pairs is aligned. Fenwick storage avoids a
// quadratic editor-sized matrix when many toolpaths are loaded.
function monotoneAnchors(pairs, verticalCount) {
  const ordered = [...pairs].sort(byHorizontalIndex);
  const tree = new Array(verticalCount + 1).fill(null);
  const better = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    if (a.barriers !== b.barriers) return a.barriers > b.barriers ? a : b;
    if (a.count !== b.count) return a.count > b.count ? a : b;
    return a.ordinal < b.ordinal ? a : b;
  };
  const query = (position) => {
    let best = null;
    for (let i = position; i > 0; i -= i & -i) best = better(best, tree[i]);
    return best;
  };
  const update = (position, state) => {
    for (let i = position; i < tree.length; i += i & -i) tree[i] = better(tree[i], state);
  };
  for (let cursor = 0; cursor < ordered.length;) {
    const batch = [];
    const hIndex = ordered[cursor].h.index;
    while (cursor < ordered.length && ordered[cursor].h.index === hIndex) {
      const pair = ordered[cursor];
      const previous = query(pair.v.index);
      const state = { pair, previous, barriers: (previous?.barriers ?? 0) + Number(pair.kind === 'barrier'), count: (previous?.count ?? 0) + 1, ordinal: cursor };
      batch.push(state);
      cursor += 1;
    }
    batch.forEach((state) => update(state.pair.v.index + 1, state));
  }
  let best = query(verticalCount);
  const result = [];
  while (best) { result.push(best.pair); best = best.previous; }
  return result.reverse();
}

// Merge the two ends of every true barrier. Source-order edges and directed
// signal→wait edges then expose dependency cycles without treating an
// assignment as a rendezvous. Iterative graph traversal handles long programs.
function findMacroDependencyCycles(hBlocks, vBlocks, barriers, macros) {
  if (!macros.length) return [];
  const count = hBlocks.length + vBlocks.length;
  const parent = Array.from({ length: count }, (_, index) => index);
  const entries = [
    ...hBlocks.map((block, index) => ({ block, index, channel: 'h' })),
    ...vBlocks.map((block, index) => ({ block, index, channel: 'v' })),
  ];
  const node = (entry) => entry.index + (entry.channel === 'v' ? hBlocks.length : 0);
  const root = (initial) => {
    let current = initial;
    while (parent[current] !== current) current = parent[current];
    while (parent[initial] !== initial) { const next = parent[initial]; parent[initial] = current; initial = next; }
    return current;
  };
  barriers.forEach((pair) => { parent[root(node(pair.v))] = root(node(pair.h)); });
  const forward = new Map();
  const reverse = new Map();
  const addEdge = (from, to) => {
    const a = root(from); const b = root(to);
    if (!forward.has(a)) forward.set(a, new Set());
    if (!forward.has(b)) forward.set(b, new Set());
    if (!reverse.has(a)) reverse.set(a, new Set());
    if (!reverse.has(b)) reverse.set(b, new Set());
    forward.get(a).add(b); reverse.get(b).add(a);
  };
  for (let i = 1; i < hBlocks.length; i += 1) addEdge(i - 1, i);
  for (let i = 1; i < vBlocks.length; i += 1) addEdge(hBlocks.length + i - 1, hBlocks.length + i);
  macros.forEach((pair) => addEdge(node(pair.signal), node(pair.wait)));

  const visited = new Set(); const order = [];
  for (const start of forward.keys()) {
    if (visited.has(start)) continue;
    const stack = [[start, false]];
    while (stack.length) {
      const [current, finished] = stack.pop();
      if (finished) { order.push(current); continue; }
      if (visited.has(current)) continue;
      visited.add(current); stack.push([current, true]);
      for (const next of forward.get(current) ?? []) if (!visited.has(next)) stack.push([next, false]);
    }
  }
  const componentByNode = new Map(); const components = [];
  for (const start of order.reverse()) {
    if (componentByNode.has(start)) continue;
    const component = [];
    const stack = [start]; const id = components.length;
    while (stack.length) {
      const current = stack.pop();
      if (componentByNode.has(current)) continue;
      componentByNode.set(current, id); component.push(current);
      for (const next of reverse.get(current) ?? []) if (!componentByNode.has(next)) stack.push(next);
    }
    components.push(component);
  }
  const cyclic = new Set();
  macros.forEach((pair) => {
    const a = root(node(pair.signal)); const b = root(node(pair.wait));
    const id = componentByNode.get(a);
    if (id === componentByNode.get(b) && (a === b || components[id]?.length > 1)) cyclic.add(id);
  });
  return [...cyclic].map((id) => entries.filter((entry) => componentByNode.get(root(node(entry))) === id));
}
