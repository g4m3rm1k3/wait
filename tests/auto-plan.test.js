import test from 'node:test';
import assert from 'node:assert/strict';
import { planWaitCodes, remapWaitOverrides } from '../src/sync/auto-plan.js';
import { clearWaitCodes } from '../src/sync/wait-codes.js';
import { parseProgram } from '../src/nc/parser.js';
import { estimateCycle } from '../src/timing/estimate.js';

const program = (body, number = 1, eol = '\n') => `%\nO${number}\nG21 G90\n${body}\nM30\n%`.replaceAll('\n', eol);
const hWindow = (seconds, n = 10, envelope = 'LEFT') => `G91 G1 F60\n(SYNC WINDOW OPEN ${envelope})\nX${seconds}\n(SYNC WINDOW CLOSE)\n(SYNC CLEAR)\nN${n}`;
const vOp = (seconds, n = 110, envelope = 'RIGHT') => `(SYNC ENVELOPE ${envelope})\nG91 G1 X${seconds} F60\n(SYNC CLEAR)\nN${n}`;
const sequential = () => ({ h: program('G91 G1 X10 F60\n(SYNC CLEAR)\nN10'), v: program(vOp(5), 2) });
const parsed = (sources, identities) => Object.fromEntries(['h', 'v'].map((channel) => {
  const blocks = parseProgram(sources[channel], {}, channel).blocks;
  if (identities) blocks.forEach((block, index) => { block.id = identities[channel][index].id; });
  return [channel, blocks];
}));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const unchanged = (result, sources) => assert.deepEqual(result.sources, sources);
const geometry = (vX = 100) => ({ sharedFrame: true, clearance: 1, initialPositions: { h: { x: 0, y: 0, z: 0 }, v: { x: vX, y: 0, z: 0 } } });

test('infers a whole-operation window from known separated XYZ paths without hand-written markers', () => {
  const sources = { h: program('G54 G91 G1 X10 F60\nN10'), v: program('G54 G91 G1 X5 F60\nN20', 2) };
  const result = planWaitCodes(sources, {}, {}, { pathGeometry: geometry() });
  assert.deepEqual(result.errors, []);
  assert.equal(result.pathAnalysis.conflicts[0].kind, 'separated');
  assert.equal(result.rows[0].mode, 'overlap');
  near(result.timing.duration, 10);
  near(result.timing.coverage.simultaneous, 5);
  assert.deepEqual(result.pathGeometry, geometry());
  assert.ok(result.sources.h.indexOf('M301P12') < result.sources.h.indexOf('G54'));
  assert.ok(result.sources.h.indexOf('M302P12') > result.sources.h.indexOf('N10'));
  for (const channel of ['h', 'v']) assert.equal(clearWaitCodes(result.sources[channel]).source, sources[channel]);
});

test('literal overlapping paths override different asserted envelope names', () => {
  const sources = { h: program(`G54\n${hWindow(10)}`), v: program(`G54\n${vOp(5)}`, 2) };
  const result = planWaitCodes(sources, {}, {}, { pathGeometry: geometry(5) });
  assert.deepEqual(result.errors, []);
  assert.equal(result.pathAnalysis.conflicts[0].kind, 'possible-overlap');
  assert.equal(result.rows[0].mode, 'sequential');
  assert.match(result.rows[0].reason, /different marker names cannot authorize/);
  assert.equal(result.timing.coverage.simultaneous, 0);
});

test('marker-free releases require the stationary V end to clear every future H path', () => {
  for (const laterH of ['G91 G1 X95 F60\nN30', 'T5\nG91 G1 X5 F60\nN30', 'G0 B90\nG91 G1 X5 F60\nN30']) {
    const sources = { h: program(`G54 G91 G1 X10 F60\nN10\n${laterH}`), v: program('G54 G91 G1 X5 F60\nN20', 2) };
    const result = planWaitCodes(sources, {}, {}, { pathGeometry: geometry() });
    assert.ok(result.errors.length, laterH);
    unchanged(result, sources);
    assert.match(result.notes.join(' '), /stationary end position/);
  }
  const sources = { h: program('G54 G91 G1 X10 F60\nN10\nX5\nN30'), v: program('G54 G91 G1 X5 F60\nN20', 2) };
  const result = planWaitCodes(sources, {}, {}, { pathGeometry: geometry() });
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].mode, 'overlap');
  assert.equal(result.rows[0].hEvent, 1);
  near(result.timing.duration, 15);
});

test('shared Y requires full Y envelope separation even if X and Z are distant', () => {
  const pathGeometry = { sharedAxis: 'y', clearance: 1, initialPositions: { h: { y: 0 }, v: { y: 100 } } };
  const sources = { h: program('G54 G91 G1 Y10 F60\nN10'), v: program('G54 G91 G1 Y5 F60\nN20', 2) };
  const result = planWaitCodes(sources, {}, {}, { pathGeometry });
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].mode, 'overlap');
  assert.equal(result.pathAnalysis.conflicts[0].axis, 'y');
  const touching = planWaitCodes({ h: program(hWindow(10)), v: program(vOp(5), 2) }, {}, {}, { pathGeometry: { ...geometry(), sharedAxis: 'y' } });
  assert.deepEqual(touching.errors, []);
  assert.equal(touching.rows[0].mode, 'sequential');
  assert.equal(touching.pathAnalysis.conflicts[0].kind, 'possible-overlap');
});

test('known unsplit manual H duration remains valid for an inferred whole-operation window', () => {
  const sources = { h: program('G54 G91 G1 X10 F60\nN10'), v: program('G54 G91 G1 X5 F60\nN20', 2) };
  const blocks = parsed(sources);
  const hOp = blocks.h.find((block) => block.kind === 'toolpath');
  const overrides = { [hOp.id]: 17 };
  const result = planWaitCodes(sources, {}, overrides, { blocks, pathGeometry: geometry() });
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].mode, 'overlap');
  assert.equal(result.overrides[hOp.id], 17);
  near(result.timing.duration, 17);
});

test('unknown starting positions and different work offsets cannot authorize geometric overlap', () => {
  for (const [settings, options, vPrefix] of [[{}, {}, 'G54'], [{}, { pathGeometry: geometry() }, 'G55']]) {
    const sources = { h: program(`G54\n${hWindow(10)}`), v: program(`${vPrefix}\n${vOp(5)}`, 2) };
    const result = planWaitCodes(sources, settings, {}, options);
    assert.deepEqual(result.errors, []);
    assert.equal(result.rows[0].mode, 'sequential');
    assert.equal(result.pathAnalysis.conflicts[0].clear, false);
  }
});

test('too-long pending V is reconsidered on each H without pairing a later V by duration', () => {
  const sources = { h: program(`${hWindow(2, 70)}\n${hWindow(10, 5)}`), v: program(vOp(5), 2) };
  const result = planWaitCodes(sources, {}, {}, { pathGeometry: geometry() });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows.map((row) => [row.hEvent, row.vEvent]), [[2, 1]]);
  assert.equal(result.rows[0].mode, 'overlap');
  assert.deepEqual(result.annotations.filter((entry) => entry.pairing === '2(wait)').map((entry) => entry.paired_with), [1, 2]);
  assert.match(result.notes.join(' '), /retried at the next H/);
  near(result.timing.duration, 12);
  assert.ok(result.sources.h.indexOf('N70') < result.sources.h.indexOf('M301P12'));
});

test('an overrun is blocked if no later H window can release the pending operation', () => {
  const sources = { h: program(hWindow(2)), v: program(vOp(5), 2) };
  const result = planWaitCodes(sources, {}, {}, { pathGeometry: geometry() });
  assert.ok(result.errors.length);
  unchanged(result, sources);
});

test('sequential placement has independent per-event handshakes and retains every original byte', () => {
  const sources = sequential();
  const frozen = JSON.stringify(sources);
  const result = planWaitCodes(sources);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].mode, 'sequential');
  assert.equal(result.waitCount, 4);
  for (const channel of ['h', 'v']) {
    assert.equal(clearWaitCodes(result.sources[channel]).source, sources[channel]);
    const barriers = parseProgram(result.sources[channel], {}, channel).blocks.filter((block) => block.sync);
    assert.deepEqual(barriers.map((block) => block.sync.key), ['301P12', '302P12']);
  }
  assert.equal(JSON.stringify(sources), frozen);
  assert.equal(result.timing.complete, true);
  near(result.timing.duration, 15);
  const actual = parsed(result.sources, result.blockIdentities);
  near(estimateCycle(actual.h, actual.v, {}, result.overrides).duration, result.timing.duration);
  assert.deepEqual(result.annotations.filter((entry) => entry.channel === 'v').map((entry) => entry.pairing), ['2(wait)', '2(release)']);
  assert.deepEqual(result.rows[0].flags, ['2(wait)', '2(release)', '1(wait)', '1(release)']);
});

test('serial release requires end-clearance assertions on both channels', () => {
  for (const channel of ['h', 'v']) {
    const sources = sequential();
    sources[channel] = sources[channel].replace('(SYNC CLEAR)\n', '');
    const result = planWaitCodes(sources);
    assert.ok(result.errors.length);
    unchanged(result, sources);
    assert.equal(result.timing, null);
  }
});

test('same envelope, missing envelope, and V tool changes cannot create an overlap', () => {
  for (const v of [vOp(5, 110, 'LEFT'), vOp(5).replace('(SYNC ENVELOPE RIGHT)\n', ''), vOp(5).replace('G91 G1', 'T5\nG91 G1')]) {
    const result = planWaitCodes({ h: program(hWindow(10)), v: program(v, 2) });
    assert.deepEqual(result.errors, []);
    assert.equal(result.rows[0].mode, 'sequential');
    assert.equal(result.timing.coverage.simultaneous, 0);
  }
});

test('preserves CRLF and CR source endings when clearing generated placement', () => {
  for (const eol of ['\r\n', '\r']) {
    const sources = { h: program('G91 G1 X10 F60\n(SYNC CLEAR)\nN10', 1, eol), v: program(vOp(5), 2, eol) };
    const result = planWaitCodes(sources);
    assert.deepEqual(result.errors, []);
    for (const channel of ['h', 'v']) assert.equal(clearWaitCodes(result.sources[channel]).source, sources[channel]);
  }
});

test('every event keeps its identity and source order; ids never repeat across releases', () => {
  const sources = {
    h: program('G91 G1 X10 F60\n(SYNC CLEAR)\nN70\nX4\n(SYNC CLEAR)\nN5'),
    v: program(`${vOp(2, 9)}\n${vOp(1, 3)}`, 2),
  };
  const result = planWaitCodes(sources);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows.map((row) => [row.hN, row.vN]), [['N70', 'N9'], ['N5', 'N3']]);
  assert.deepEqual(result.rows.flatMap((row) => [row.releaseId, row.completeId]), [301, 302, 303, 304]);
  assert.deepEqual(result.annotations.filter((entry) => entry.pairing === '2(release)').map((entry) => entry.event), [1, 2]);
  for (const channel of ['h', 'v']) assert.equal(clearWaitCodes(result.sources[channel]).source, sources[channel]);
  near(result.timing.duration, 17);
});

test('does not dump unmatched V operations at the end', () => {
  const sources = sequential();
  sources.v = program(`${vOp(2, 9)}\n${vOp(1, 3)}`, 2);
  const result = planWaitCodes(sources);
  assert.match(result.errors.join(' '), /remaining events were not moved to the end/);
  unchanged(result, sources);
});

test('longer V is timed accurately during a sequential release without reordering', () => {
  const sources = sequential();
  sources.v = program(vOp(30), 2);
  const result = planWaitCodes(sources);
  assert.deepEqual(result.errors, []);
  assert.equal(result.longerChannel, 'v');
  near(result.timing.duration, 40);
  near(result.timing.channels.h.wait, 30);
  near(result.timing.channels.v.cut, 30);
});

test('custom template, range, and machine channel selection are validated together', () => {
  const sources = sequential();
  const settings = { waitTemplate: 'M{id} P{p}', waitPattern: '\\bM(5\\d{2})\\s*P(\\d+)\\b', hChannel: '3', vChannel: '4' };
  const result = planWaitCodes(sources, settings, {}, { startId: 501, participants: '34' });
  assert.deepEqual(result.errors, []);
  assert.match(result.sources.h, /M501 P34/);
  assert.equal(clearWaitCodes(result.sources.h, settings).source, sources.h);
  for (const options of [{ startId: 599 }, { startId: -1 }, { participants: '13' }, { participants: '43' }]) {
    const blocked = planWaitCodes(sources, settings, {}, options);
    assert.ok(blocked.errors.length);
    unchanged(blocked, sources);
  }
  assert.ok(planWaitCodes(sources, {}, {}, { participants: '13' }).errors.length);
});

test('existing synchronization is never stripped implicitly and generated plans replace idempotently', () => {
  const sources = sequential();
  for (const code of ['M320P12', '#501=20', 'WHILE[#501NE20]DO1\nEND1']) {
    const existing = { ...sources, h: sources.h.replace('M30', `${code}\nM30`) };
    const blocked = planWaitCodes(existing);
    assert.ok(blocked.errors.some((message) => /imported waits|macro/.test(message)));
    unchanged(blocked, existing);
  }
  const first = planWaitCodes(sources);
  const second = planWaitCodes(first.sources, {}, first.overrides, { blocks: parsed(first.sources, first.blockIdentities) });
  assert.deepEqual(second.errors, []);
  assert.deepEqual(second.sources, first.sources);
  near(second.timing.duration, first.timing.duration);
});

test('wait ID collision and exhaustion cannot emit malformed or reused synchronization', () => {
  const sources = sequential();
  const exhausted = planWaitCodes(sources, {}, {}, { startId: 399 });
  assert.match(exhausted.errors.join(' '), /exhausted/);
  unchanged(exhausted, sources);
  const collisionSources = { ...sources, h: sources.h.replace('G91', 'M301\nG91') };
  const blocks = parsed(collisionSources);
  const overrides = { [blocks.h.find((block) => block.kind === 'toolpath').id]: 10 };
  const collision = planWaitCodes(collisionSources, {}, overrides, { blocks });
  assert.match(collision.errors.join(' '), /already occurs/);
  unchanged(collision, collisionSources);
  const template = planWaitCodes(sources, { waitTemplate: 'M{id}P{p}\nM30' });
  assert.ok(template.errors.length);
});

test('manual operation times and custom workspace identities survive insertion and clearing', () => {
  const sources = sequential();
  const blocks = parsed(sources);
  for (const channel of ['h', 'v']) blocks[channel].forEach((block, index) => { block.id = `${channel}-workspace-${index}`; });
  const hOp = blocks.h.find((block) => block.kind === 'toolpath');
  const vOp = blocks.v.find((block) => block.kind === 'toolpath');
  const overrides = { [hOp.id]: 70, [vOp.id]: 23 };
  const original = JSON.stringify({ sources, overrides, blocks });
  const result = planWaitCodes(sources, {}, overrides, { blocks });
  assert.deepEqual(result.errors, []);
  near(result.timing.duration, 93);
  assert.equal(result.overrides[hOp.id], 70);
  assert.equal(result.overrides[vOp.id], 23);
  const cleared = Object.fromEntries(['h', 'v'].map((channel) => [channel, clearWaitCodes(result.sources[channel]).source]));
  const remapped = remapWaitOverrides(parsed(result.sources, result.blockIdentities), cleared, {}, result.overrides);
  assert.equal(remapped.overrides[hOp.id], 70);
  assert.equal(remapped.overrides[vOp.id], 23);
  assert.equal(JSON.stringify({ sources, overrides, blocks }), original);
});

test('clearing generated split waits adds measured and modeled fragment times exactly', () => {
  const sources = {
    h: program('G91 G1 X2 F60\nM301P12 (SPINDLE SYNC AUTO 1 RELEASE)\nX5\nM302P12 (SPINDLE SYNC AUTO 1 COMPLETE)\nX3\nN10'),
    v: program('M301P12 (SPINDLE SYNC AUTO 1 RELEASE)\nG91 G1 X4 F60\nN20\nM302P12 (SPINDLE SYNC AUTO 1 COMPLETE)', 2),
  };
  const blocks = parsed(sources);
  const measured = blocks.h.find((block) => block.text === 'X5\n');
  const overrides = { [measured.id]: 17 };
  const cleared = Object.fromEntries(['h', 'v'].map((channel) => [channel, clearWaitCodes(sources[channel]).source]));
  const remapped = remapWaitOverrides(blocks, cleared, {}, overrides);
  const next = parsed(cleared, remapped.blockIdentities);
  const operation = next.h.find((block) => block.kind === 'toolpath');
  assert.equal(remapped.overrides[operation.id], 22);
  near(estimateCycle(next.h, next.v, {}, remapped.overrides).channels.h.cut, 22);
});

test('clearing imported recognized barriers also keeps measurements across merged blocks', () => {
  const sources = { h: program('G1 X10 F600\nM301P12\nG1 X20\nN10'), v: program('M301P12\nG1 X5 F600\nN20', 2) };
  const blocks = parsed(sources);
  const fragments = blocks.h.filter((block) => /G1 X/.test(block.text));
  const overrides = { [fragments[0].id]: 10, [fragments[1].id]: 20 };
  const cleared = Object.fromEntries(['h', 'v'].map((channel) => [channel, clearWaitCodes(sources[channel], {}, { scope: 'recognized' }).source]));
  const remapped = remapWaitOverrides(blocks, cleared, {}, overrides);
  const next = parsed(cleared, remapped.blockIdentities);
  const operation = next.h.find((block) => block.kind === 'toolpath');
  assert.equal(remapped.overrides[operation.id], 30);
  near(estimateCycle(next.h, next.v, {}, remapped.overrides).channels.h.cut, 30);
});

test('blocks incomplete programs, executable tails, loops, conditional labels, optional stops, and malformed assertions', () => {
  const sources = sequential();
  const badH = [
    sources.h.replace('M30\n', ''),
    sources.h.replace('M30', 'G0 X0\nM30'),
    sources.h.replace('M30', 'M30\nG0 X0'),
    sources.h.replace('G91', '/G91'),
    sources.h.replace('G91', 'GOTO10\nG91'),
    sources.h.replace('G91', 'M98 P99\nG91'),
    sources.h.replace('G91', 'M1\nG91'),
    sources.h.replace('(SYNC CLEAR)', '(SYNC CLEAR) G0 X0'),
    sources.h.replace('(SYNC CLEAR)', '(SYNC CLEAR)\nX1'),
    sources.h.replace('(SYNC CLEAR)', '(SYNC WINDOW OPEN LEFT)'),
    sources.h.replace('(SYNC CLEAR)', '(UNCLOSED'),
    program(hWindow(10).replace('X10', 'T5\nX10')),
  ];
  for (const h of badH) {
    const input = { ...sources, h };
    const blocks = parsed(input);
    // A manual time must never conceal unsupported control flow.
    const overrides = Object.fromEntries(blocks.h.filter((block) => !block.sync).map((block) => [block.id, 10]));
    const result = planWaitCodes(input, {}, overrides, { blocks });
    assert.ok(result.errors.length, h);
    unchanged(result, input);
  }
});

test('unmodeled operation durations need manual values; measured arcs may be sequential', () => {
  const sources = sequential();
  sources.v = program('(SYNC ENVELOPE RIGHT)\nG2 X5 I2 F60\n(SYNC CLEAR)\nN20', 2);
  const unknown = planWaitCodes(sources);
  assert.match(unknown.errors.join(' '), /known duration/);
  const blocks = parsed(sources);
  const override = { [blocks.v.find((block) => block.kind === 'toolpath').id]: 6 };
  const known = planWaitCodes(sources, {}, override, { blocks });
  assert.deepEqual(known.errors, []);
  near(known.timing.duration, 16);
});
