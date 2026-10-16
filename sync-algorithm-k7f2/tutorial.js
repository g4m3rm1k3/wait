/**
 * Drives the walkthrough page. All planning comes from planner.js (the tested
 * copy of sync_plan.py); this file only draws it and replays its steps.
 */
import { DEFAULT_SETTINGS, planAll, timeline, stretchTiming } from './planner.js';

const EXAMPLE = `FAM_2H 11001 := 01:15
FAM_2H 12001 := 00:44
FAM_2H 12002 := 00:47
FAM_2V 11010 := 00:15
FAM_2V 21010 := 00:24
FAM_2V 11011 := 00:30
FAM_2V 21011 := 00:25
FAM_2V 11012 := 00:34`;

const $ = (id) => document.getElementById(id);
const fmt = (x) => (x === Infinity ? '∞' : String(Math.round(x * 10) / 10));
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private window */ } },
};

let settings = { ...DEFAULT_SETTINGS };
let result = null; // planAll() output
let frames = [];
let frame = 0;
let timer = null;
let cuts = []; // section 2: V pieces done when stretch k ends, k = 1..S-1

// ---- input -------------------------------------------------------------------
function readSettings() {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const el = $(key);
    if (typeof DEFAULT_SETTINGS[key] === 'boolean') settings[key] = el.checked;
    else settings[key] = Math.max(0, Number(el.value) || 0);
  }
}
function writeSettings() {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const el = $(key);
    if (typeof DEFAULT_SETTINGS[key] === 'boolean') el.checked = settings[key];
    else el.value = settings[key];
  }
}

function run() {
  stop();
  readSettings();
  const text = $('ops').value;
  store.set('sync-tutorial-ops', text);
  const out = planAll(text, settings);
  $('errors').textContent = out.errors.join('\n');
  if (out.errors.length) return;
  if (out.v.length > 30 || out.stretches.length > 12) {
    $('errors').textContent = 'Keep it to 30 V ops and 12 stretches or fewer so the table stays readable.';
    return;
  }
  result = out;
  cuts = result.plan.cuts.slice(0, -1).map(([, j]) => j);
  drawQuestion();
  drawSliders();
  drawCounts();
  drawIngredients();
  buildFrames();
  showFrame(0);
  drawAnswer();
}

// ---- bars ----------------------------------------------------------------------
function bar(el, items) {
  const total = items.reduce((a, b) => a + b.size, 0) || 1;
  el.innerHTML = items.map((it) => `<div class="seg ${it.cls}" style="flex:${Math.max(it.size, total * 0.012)}" title="${esc(it.title || it.label)}">${esc(it.label)}</div>`).join('');
}
function hItems(cur = -1) {
  return result.stretches.map((st, s) => ({
    size: st.seconds,
    cls: `h ${cur < 0 ? '' : s === cur ? 'cur' : s < cur ? 'done' : 'later'}`,
    label: `${s + 1}: ${st.ops.map((o) => 'T' + o.tool).join('/')} ${fmt(st.seconds)}s`,
    title: `Stretch ${s + 1}${st.event ? ` starts with a B event (lockout ${st.lockout}s)` : ''}: ${st.ops.map((o) => o.text).join(', ')}`,
  }));
}
function vItems(i = -1, j = -1) {
  return result.plan.pieces.map((w, k) => ({
    size: w,
    cls: `v ${i < 0 ? '' : k >= i && k < j ? 'cur' : k < i ? 'done' : 'later'}`,
    label: `p${k + 1} ${fmt(w)}s`,
    title: `Piece ${k + 1}: ${result.v[k].text} (cutting + next op's tool change)`,
  }));
}

function drawQuestion() {
  bar($('q-h'), hItems());
  bar($('q-v'), vItems());
}

// ---- gantt -----------------------------------------------------------------------
function gantt(el, rows, end) {
  const x = (t) => `${(t / end) * 100}%`;
  const w = (a, b) => `${(Math.max(0, b - a) / end) * 100}%`;
  const box = (cls, a, b, label, title) => (b - a > 0
    ? `<div class="g ${cls}" style="left:${x(a)};width:${w(a, b)}" title="${esc(title || label)}">${(b - a) / end > 0.05 ? esc(label) : ''}</div>` : '');
  let hLane = '';
  let vLane = '';
  let events = '';
  const pre = result.plan.pre;
  rows.forEach((r) => {
    const t = r.t;
    const start = t + r.lead;
    if (r.s === 0 && pre) vLane += box('tc', 0, pre, 'T', `V's first tool change (${pre}s)`);
    if (r.lead) hLane += box('wait', t, start, 'waits', `H waits ${r.lead}s for V's first tool change`);
    if (r.lockout) {
      events += `<div class="event-line" style="left:${x(start)}" title="B event: stretch ${r.s + 1}"></div>`;
      vLane += box('lock', start, start + r.lockout, 'B', `B moving: V can't cut (${r.lockout}s)`);
    }
    hLane += box('h', start, start + r.hSeconds, `S${r.s + 1} ${r.hTools}`, `Stretch ${r.s + 1}: ${fmt(r.hSeconds)}s`);
    const hEnd = start + r.hSeconds;
    if (t + r.cost - hEnd > 0.001) hLane += box('wait', hEnd, t + r.cost, 'H waits', `H waits ${fmt(t + r.cost - hEnd)}s for V to finish`);
    if (r.n) vLane += box('v', t + r.vStart, t + r.vStart + r.w, r.n === 1 ? `op ${r.firstV + 1}` : `ops ${r.firstV + 1}-${r.firstV + r.n}`, `V ops ${r.firstV + 1}-${r.firstV + r.n}: ${fmt(r.w)}s incl. next tool change`);
  });
  const step = [10, 20, 30, 60, 120, 300].find((s) => end / s <= 8) || 600;
  let axis = '';
  for (let t = 0; t <= end + 0.001; t += step) axis += `<span style="left:${x(t)}">${t}s</span>`;
  el.innerHTML = `<div class="gantt">
    <div class="lane-name">H</div><div class="lane">${hLane}${events}</div>
    <div class="lane-name">V</div><div class="lane">${vLane}${events}</div>
    <div class="axis">${axis}</div></div>
    <div class="legend"><span><i style="background:var(--h)"></i>H cutting (incl. its B move / tool change)</span>
    <span><i style="background:var(--v)"></i>V cutting + next tool change</span>
    <span><i class="g lock" style="position:static;display:inline-block"></i>B moving, V can't cut</span>
    <span><i style="background:var(--wait-soft);border:1px solid var(--wait)"></i>H waiting</span>
    <span><i style="background:var(--accent)"></i>B event</span></div>`;
}

// ---- section 2: sliders ---------------------------------------------------------
function groupsFromCuts() {
  const bounds = [0, ...cuts, result.v.length];
  return result.stretches.map((_, s) => result.v.slice(bounds[s], bounds[s + 1]));
}
function drawSliders() {
  const n = result.v.length;
  const S = result.stretches.length;
  const el = $('sliders');
  if (S < 2) {
    el.innerHTML = '<p class="small muted">Only one H stretch: every V op runs in it, nothing to choose.</p>';
  } else {
    el.innerHTML = cuts.map((c, k) => `<div class="slider-row">
      <span class="sl-name">V pieces done by B event ${k + (result.stretches[0].event ? 2 : 1)}</span>
      <input type="range" min="0" max="${n}" value="${c}" data-k="${k}">
      <span class="mono" id="cut-${k}">${c}</span></div>`).join('');
    el.querySelectorAll('input').forEach((input) => {
      input.oninput = () => {
        const k = Number(input.dataset.k);
        cuts[k] = Number(input.value);
        for (let m = 0; m < cuts.length; m++) {
          if (m < k && cuts[m] > cuts[k]) cuts[m] = cuts[k];
          if (m > k && cuts[m] < cuts[k]) cuts[m] = cuts[k];
        }
        updateSliders();
      };
    });
  }
  updateSliders();
}
function updateSliders() {
  const tl = timeline(result.stretches, groupsFromCuts(), result.v, settings);
  $('sliders').querySelectorAll('input').forEach((input, k) => { input.value = cuts[k]; $(`cut-${k}`).textContent = cuts[k]; });
  const best = result.plan.cycle;
  $('mine-cycle').textContent = `${fmt(tl.end)}s`;
  $('mine-cycle').className = `big ${tl.end <= best + 1e-9 ? 'ok' : 'bad'}`;
  $('best-cycle').textContent = `${fmt(best)}s`;
  const greedyGroups = (() => { const saved = cuts; cuts = greedyCuts(); const g = groupsFromCuts(); cuts = saved; return g; })();
  $('greedy-cycle').textContent = `${fmt(timeline(result.stretches, greedyGroups, result.v, settings).end)}s`;
  gantt($('mine-gantt'), tl.rows, Math.max(tl.end, best));
}
/** The obvious way: give each stretch as many V pieces as fit before H finishes. */
function greedyCuts() {
  const { pieces } = result.plan;
  const out = [];
  let idx = 0;
  result.stretches.forEach((st, s) => {
    const room = st.seconds - st.lockout;
    let w = 0;
    while (s < result.stretches.length - 1 && idx < pieces.length && w + pieces[idx] <= room) w += pieces[idx++];
    if (s < result.stretches.length - 1) out.push(idx);
  });
  return out;
}
$('use-greedy').onclick = () => {
  cuts = greedyCuts();
  updateSliders();
};
$('use-best').onclick = () => {
  cuts = result.plan.cuts.slice(0, -1).map(([, j]) => j);
  updateSliders();
};

// ---- section 3: counts ------------------------------------------------------------
function choose(n, k) {
  let r = 1n;
  for (let i = 1n; i <= BigInt(k); i++) r = (r * (BigInt(n) - BigInt(k) + i)) / i;
  return r;
}
function drawCounts() {
  const rows = [
    ['This list', result.v.length, result.stretches.length],
    ['A typical job', 12, 5],
    ['A big job', 24, 8],
    ['Bigger still', 40, 12],
  ];
  $('counts').innerHTML = `<tr><th></th><th>V ops (n)</th><th>H stretches (S)</th><th>Every split</th><th>Table</th></tr>` +
    rows.map(([name, n, S]) => `<tr><td>${name}</td><td>${n}</td><td>${S}</td>
      <td>${choose(n + S - 1, S - 1).toLocaleString()}</td>
      <td>${(S * (n + 1) * (n + 2) / 2).toLocaleString()}</td></tr>`).join('');
}

// ---- section 4: ingredients -----------------------------------------------------
function drawIngredients() {
  $('t-stretch').innerHTML = '<tr><th>s</th><th>H ops</th><th>H time</th><th>B event</th><th>lockout</th></tr>' +
    result.stretches.map((st, s) => `<tr><td>${s + 1}</td><td>${st.ops.map((o) => `T${o.tool} rot${o.rotation} off${o.offset}`).join('<br>')}</td>
      <td>${fmt(st.seconds)}s</td><td>${st.event ? (s === 0 ? 'cycle start' : st.lockout === settings.TOOL_CHANGE_LOCKOUT_SECONDS ? 'tool change' : 'rotation') : '—'}</td><td>${st.lockout}s</td></tr>`).join('');
  const { pre, pieces } = result.plan;
  const tcs = result.v.map((op, j) => (j > 0 && op.tool === result.v[j - 1].tool ? 0 : Math.min(settings.V_TOOL_CHANGE_SECONDS, op.seconds)));
  $('t-pieces').innerHTML = `<tr><th>piece</th><th>V op</th><th>op time</th><th>− own TC</th><th>+ next TC</th><th>piece</th></tr>` +
    result.v.map((op, j) => `<tr><td>p${j + 1}</td><td class="mono">T${op.tool} off${op.offset}</td><td>${fmt(op.seconds)}</td>
      <td>${tcs[j] ? '−' + tcs[j] : '0'}</td><td>${j + 1 < tcs.length && tcs[j + 1] ? '+' + tcs[j + 1] : '0'}</td><td><b>${fmt(pieces[j])}</b></td></tr>`).join('') +
    `<tr><td colspan="6" class="muted">pre = ${pre}s (V's first tool change, before its first wait)</td></tr>`;
}

// ---- section 5: stepper -----------------------------------------------------------
const CODE = [
  [1, 'pre, piece[1..n] ← v_pieces(V)', 'tool changes move to the op before'],
  [2, 'best[0][0] ← 0;  every other best ← ∞', ''],
  [3, 'for s ← 1 to S:', 'each H stretch'],
  [4, '  for j ← 0 to n:', 'V pieces done after it'],
  [5, '    for i ← 0 to j:', 'V pieces done before it'],
  [6, '      if best[s-1][i] = ∞: next i', 'can\'t get here'],
  [7, '      W ← piece[i+1] + … + piece[j]', 'V\'s group this stretch'],
  [8, '      cost ← stretch_cost(s, W)', 'see section 4'],
  [9, '      if best[s-1][i] + cost < best[s][j]:', ''],
  [10, '        best[s][j] ← best[s-1][i] + cost', ''],
  [11, '        from[s][j] ← i', 'remember the cut'],
  [12, 'cycle ← best[S][n]', ''],
  [13, 'j ← n;  for s ← S down to 1:', 'walk back'],
  [14, '  group[s] ← pieces from[s][j]+1 … j;  j ← from[s][j]', ''],
];
function buildFrames() {
  frames = [{ lines: [1], kind: 'pre' }, { lines: [2], kind: 'init', upto: -1 }];
  result.plan.steps.forEach((step, k) => {
    if (step.kind === 'skip') frames.push({ lines: [3, 4, 5, 6], step, upto: k });
    else frames.push({ lines: step.better ? [7, 8, 9, 10, 11] : [7, 8, 9], ok: step.better, step, upto: k });
  });
  const last = result.plan.steps.length - 1;
  frames.push({ lines: [12], kind: 'cycle', upto: last });
  const S = result.stretches.length;
  for (let s = S; s >= 1; s--) frames.push({ lines: [13, 14], kind: 'walk', walk: S - s + 1, upto: last });
  $('code').innerHTML = CODE.map(([n, t, c]) => `<div class="ln" data-n="${n}"><b>${n}</b><span>${esc(t)}${c ? `  <span class="cm"># ${esc(c)}</span>` : ''}</span></div>`).join('');
}

function tableAt(upto) {
  const S = result.stretches.length;
  const n = result.v.length;
  const best = Array.from({ length: S + 1 }, () => new Array(n + 1).fill(Infinity));
  const from = Array.from({ length: S + 1 }, () => new Array(n + 1).fill(null));
  best[0][0] = 0;
  for (let k = 0; k <= upto; k++) {
    const st = result.plan.steps[k];
    if (st.kind === 'try' && st.better) { best[st.s][st.j] = st.total; from[st.s][st.j] = st.i; }
  }
  return { best, from };
}

function walkPath(count) {
  const path = [];
  const S = result.stretches.length;
  let j = result.v.length;
  path.push([S, j]);
  for (let s = S; s > S - count; s--) {
    j = result.plan.from[s][j];
    path.push([s - 1, j]);
  }
  return path;
}

function costFormula(s, w) {
  const st = result.stretches[s - 1];
  const pre = result.plan.pre;
  if (s === 1 && !st.event) return `max(H ${fmt(st.seconds)}, pre ${pre} + W ${fmt(w)})`;
  const lead = s === 1 ? `pre ${pre} + ` : '';
  return `${lead}max(H ${fmt(st.seconds)}, lockout ${st.lockout} + W ${fmt(w)})`;
}
const groupText = (i, j) => (i === j ? 'no V pieces' : j - i === 1 ? `V piece p${j}` : `V pieces p${i + 1}–p${j}`);

function showFrame(k) {
  frame = Math.max(0, Math.min(frames.length - 1, k));
  const f = frames[frame];
  $('count').textContent = `step ${frame + 1} / ${frames.length}`;
  document.querySelectorAll('#code .ln').forEach((ln) => {
    const n = Number(ln.dataset.n);
    ln.className = `ln${f.lines.includes(n) ? (f.ok && n >= 10 ? ' on2' : ' on') : ''}`;
  });
  const { best, from } = f.upto === undefined ? { best: [[0]], from: [[null]] } : tableAt(f.upto);
  const S = result.stretches.length;
  const n = result.v.length;
  let src = null;
  let dst = null;
  let path = [];
  let narrate = '';
  let vars = [];
  const st = f.step;
  if (f.kind === 'pre') {
    narrate = `V's tool changes happen before its <code>(WAIT)</code>, so each one is moved onto the op before it. That gives ${n} pieces and <b>pre = ${result.plan.pre}s</b> (V's first tool change). Section 4 shows the arithmetic.`;
    bar($('s-h'), hItems()); bar($('s-v'), vItems());
  } else if (f.kind === 'init') {
    narrate = 'Row 0 is "before any H stretch": the only way to be there is with 0 V pieces done, at time 0. Every other cell starts at ∞ ("not reached yet").';
    bar($('s-h'), hItems()); bar($('s-v'), vItems());
  } else if (st) {
    vars = [`s=${st.s}`, `j=${st.j}`, `i=${st.i}`];
    src = [st.s - 1, st.i];
    dst = [st.s, st.j];
    bar($('s-h'), hItems(st.s - 1));
    bar($('s-v'), vItems(st.i, st.j));
    if (st.kind === 'skip') {
      narrate = `best[${st.s - 1}][${st.i}] is ∞: after ${st.s - 1} stretch${st.s - 1 === 1 ? '' : 'es'} V can't have done ${st.i} pieces, so there's nothing to build on. Skip.`;
    } else {
      vars.push(`W=${fmt(st.w)}`, `cost=${fmt(st.cost)}`, `best[${st.s - 1}][${st.i}]=${fmt(best[st.s - 1][st.i])}`);
      narrate = `Stretch ${st.s} gets <b>${groupText(st.i, st.j)}</b>${st.i === st.j ? '' : ` (W = ${fmt(st.w)}s)`}.<br>
        cost = ${costFormula(st.s, st.w)} = <b>${fmt(st.cost)}s</b>.<br>
        best[${st.s - 1}][${st.i}] + cost = ${fmt(st.total - st.cost)} + ${fmt(st.cost)} = <b>${fmt(st.total)}</b>
        ${st.better ? `&lt; ${fmt(st.before)} → <span class="better">new best[${st.s}][${st.j}]</span>` : `≥ ${fmt(st.before)} → <span class="worse">keep ${fmt(st.before)}</span>`}`;
    }
  } else if (f.kind === 'cycle') {
    narrate = `The bottom-right cell is the answer: all ${S} stretches done and all ${n} V pieces done. <b>Shortest cycle = ${fmt(result.plan.cycle)}s.</b>`;
    dst = [S, n];
    bar($('s-h'), hItems()); bar($('s-v'), vItems());
  } else if (f.kind === 'walk') {
    path = walkPath(f.walk);
    const s = S - f.walk + 1;
    const [i, j] = result.plan.cuts[s - 1];
    narrate = `from[${s}][${j}] = ${i}: stretch ${s} gets <b>${groupText(i, j)}</b>. ` +
      (s > 1 || result.stretches[0].event ? `V's <code>(WAIT)</code> for this stretch's B event goes ${i < n ? `in front of V op ${i + 1}` : 'before V\'s M30'}.` : 'No B event before this stretch, so no wait.') +
      (s > 1 ? ` Next, look at row ${s - 1}, column ${i}.` : ' Done.');
    bar($('s-h'), hItems(s - 1));
    bar($('s-v'), vItems(i, j));
  }
  $('narrate').innerHTML = narrate;
  $('vars').innerHTML = vars.map((v) => `<span>${v}</span>`).join('');

  const onPath = (s, j) => path.some(([a, b]) => a === s && b === j);
  let html = `<tr><th></th>${Array.from({ length: n + 1 }, (_, j) => `<th>j=${j}</th>`).join('')}</tr>`;
  for (let s = 0; s <= S; s++) {
    html += `<tr><th class="rowh">${s === 0 ? 's=0 start' : `s=${s}`}</th>`;
    for (let j = 0; j <= n; j++) {
      const value = best[s]?.[j] ?? Infinity;
      const cls = [
        value === Infinity ? 'inf' : '',
        src && src[0] === s && src[1] === j ? 'src' : '',
        dst && dst[0] === s && dst[1] === j ? 'dst' : '',
        dst && dst[0] === s && dst[1] === j && st?.better ? 'upd' : '',
        onPath(s, j) ? 'path' : '',
      ].join(' ');
      const fr = from[s]?.[j];
      html += `<td class="${cls}">${fmt(value)}${fr !== null && fr !== undefined ? `<small>from ${fr}</small>` : ''}</td>`;
    }
    html += '</tr>';
  }
  $('dp').innerHTML = html;
}

function stop() {
  clearInterval(timer);
  timer = null;
  $('play').textContent = '▶ Play';
}
function play() {
  if (timer) return stop();
  if (frame >= frames.length - 1) showFrame(0);
  $('play').textContent = '⏸ Pause';
  const tick = () => {
    if (frame >= frames.length - 1) return stop();
    showFrame(frame + 1);
  };
  timer = setInterval(tick, Number($('speed').value));
}
$('play').onclick = play;
$('speed').oninput = () => { if (timer) { stop(); play(); } };
$('first').onclick = () => { stop(); showFrame(0); };
$('last').onclick = () => { stop(); showFrame(frames.length - 1); };
$('prev').onclick = () => { stop(); showFrame(frame - 1); };
$('next').onclick = () => { stop(); showFrame(frame + 1); };
$('next-row').onclick = () => {
  stop();
  const s = frames[frame].step?.s ?? 0;
  const k = frames.findIndex((f, idx) => idx > frame && (!f.step || f.step.s > s));
  showFrame(k < 0 ? frames.length - 1 : k);
};
document.addEventListener('keydown', (e) => {
  if (['TEXTAREA', 'INPUT'].includes(document.activeElement?.tagName)) return;
  if (e.key === 'ArrowRight') { stop(); showFrame(frame + 1); }
  else if (e.key === 'ArrowLeft') { stop(); showFrame(frame - 1); }
  else if (e.key === ' ') { e.preventDefault(); play(); }
});

// ---- section 6: answer ---------------------------------------------------------------
function drawAnswer() {
  gantt($('answer-gantt'), result.timeline.rows, result.timeline.end);
  $('timeline').textContent = result.timeline.lines.join('\n');
  $('marked').textContent = result.marked.join('\n');
}

// ---- start -------------------------------------------------------------------------
$('run').onclick = run;
$('reset-ops').onclick = () => { $('ops').value = EXAMPLE; settings = { ...DEFAULT_SETTINGS }; writeSettings(); run(); };
for (const key of Object.keys(DEFAULT_SETTINGS)) $(key).onchange = run;
$('theme').onclick = () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  store.set('sync-tutorial-theme', root.dataset.theme);
};
const savedTheme = store.get('sync-tutorial-theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$('ops').value = store.get('sync-tutorial-ops') || EXAMPLE;
writeSettings();
run();
// #step=N opens the walkthrough at step N (handy for coming back to a spot).
const linked = /step=(\d+)/.exec(location.hash);
if (linked) {
  showFrame(Number(linked[1]) - 1);
  $('code').closest('section').scrollIntoView();
}
