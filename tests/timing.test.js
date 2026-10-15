import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCycle } from '../src/timing.js';

const block = (id, text, flags = {}) => ({ id, text, kind: 'toolpath', flags });
const barrier = (id, key = '301P12') => ({ id, text: '', kind: 'wait', sync: { kind: 'barrier', role: 'barrier', key } });
const signal = (id, variable, value) => ({ id, text: '', kind: 'signal', sync: { kind: 'macro', role: 'signal', key: `#${variable}=${value}`, variable: String(variable), value: String(value) } });
const wait = (id, variable, value) => ({ id, text: '', kind: 'macro-wait', sync: { kind: 'macro', role: 'wait', key: `#${variable}=${value}`, variable: String(variable), value: String(value) } });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);

test('estimates modal linear motion, rapid travel, and each tool change in seconds', () => {
  const result = estimateCycle([block('h-path', '(M6 G1 X900)\nG21 G90\nM06\nG0 X100\nG1 X200 F600\nX300 ; M6 X10000\nT2 M6\nN10')], [], { rapidFeed: 10000, toolChangeSeconds: 8 });
  assert.equal(result.complete, true);
  near(result.duration, 36.6);
  near(result.channels.h.cut, 20);
  near(result.channels.h.air, 0.6);
  near(result.channels.h.toolChange, 16);
  near(result.channels.h.utilization, 20 / 36.6);
  near(result.channels.v.wait, result.duration);
  near(result.channels.v.total, result.duration);
  assert.equal(result.segments.v.at(-1).label, 'Idle after channel completes');
});

test('G20/G21 and G90/G91 change coordinates and modal program feed correctly', () => {
  const result = estimateCycle([block('h-path', 'G20 G90 G1 X1 F1\nG91 X1\nG21 G90 X0 F25.4')], []);
  near(result.duration, 240);
  near(result.channels.h.cut, 240);
  assert.equal(result.complete, true);
});

test('configured cutting feed can replace program feed, while B rotation uses degrees per minute', () => {
  const result = estimateCycle([block('h-path', 'G21 G90 G1 X100 F5\nG0 B90')], [], { cutFeed: 600, useProgramFeed: false, rotationFeed: 180 });
  near(result.channels.h.cut, 10);
  near(result.channels.h.air, 30);
  near(result.duration, 40);
});

test('arcs including modal arc motion require an override; manual time resolves the block', () => {
  const source = [block('arc', 'G90 G2 X10 Y10 I10 J0 F600\nX20 Y0 I0 J-10')];
  const partial = estimateCycle(source, []);
  assert.equal(partial.complete, false);
  assert.equal(partial.blockTimes.arc.unknown, true);
  assert.ok(partial.diagnostics.some(diagnostic => diagnostic.code === 'unknown-block-time'));
  assert.equal(partial.segments.h.filter(segment => segment.type === 'unknown').length, 2);
  const manual = estimateCycle(source, [], {}, { arc: 12.5 });
  assert.equal(manual.complete, true);
  near(manual.duration, 12.5);
  near(manual.channels.h.cut, 12.5);
  assert.equal(manual.blockTimes.arc.unknown, undefined);
});

test('full-circle and modal center-only arcs remain unknown rather than disappearing', () => {
  const result = estimateCycle([block('circle', 'G2 I10 J0 F600\nI0 J10')], []);
  assert.equal(result.complete, false);
  assert.equal(result.segments.h.filter(segment => segment.type === 'unknown').length, 2);
});

test('a manually timed dwell preserves the following linear starting position', () => {
  const result = estimateCycle([block('before', 'G1 X10 F600'), block('dwell', 'G4 P1000'), block('after', 'X20')], [], {}, { dwell: 1 });
  assert.equal(result.complete, true);
  near(result.duration, 3);
});

test('out-of-range coordinates never yield infinite times', () => {
  const result = estimateCycle([block('huge', `G1 X${'9'.repeat(400)} F600`)], []);
  assert.equal(result.complete, false);
  assert.ok(Number.isFinite(result.duration));
});

test('paired barriers wait for the partner and repeated occurrences are distinct', () => {
  const h = [block('h1', 'G1 X100 F600'), barrier('hb1'), block('h2', 'X200'), barrier('hb2')];
  const v = [block('v1', 'G1 X200 F600'), barrier('vb1'), block('v2', 'X250'), barrier('vb2')];
  const result = estimateCycle(h, v);
  assert.equal(result.complete, true);
  near(result.duration, 30);
  near(result.channels.h.cut, 20);
  near(result.channels.h.wait, 10);
  near(result.channels.v.cut, 25);
  near(result.channels.v.wait, 5);
  const vWait = result.segments.v.find(segment => segment.blockId === 'vb2');
  near(vWait.start, 25);
  near(vWait.end, 30);
});

test('a macro release lets the other channel cut during a tool change without a paired barrier', () => {
  const h = [block('h-cut', 'G1 X100 F600'), signal('release', 501, 20), block('h-change', 'T2 M6', { toolChange: true })];
  const v = [wait('v-wait', 501, 20), block('v-cut', 'G1 X50 F600')];
  const result = estimateCycle(h, v, { toolChangeSeconds: 8 });
  assert.equal(result.complete, true);
  near(result.duration, 18);
  const vCut = result.segments.v.find(segment => segment.blockId === 'v-cut');
  const hChange = result.segments.h.find(segment => segment.type === 'toolChange');
  near(vCut.start, 10);
  near(vCut.end, 15);
  near(hChange.start, 10);
  near(hChange.end, 18);
  near(result.channels.v.wait, 13);
});

test('macro waits use the value when reached, never a historical matching assignment', () => {
  const h = [signal('once', 501, 10), block('h-delay', 'G1 X10 F600'), signal('overwrite', 501, 20)];
  const v = [block('v-delay', 'G1 X20 F600'), wait('too-late', 501, 10)];
  const result = estimateCycle(h, v);
  assert.equal(result.complete, false);
  near(result.duration, 2);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'synchronization-stalled' && diagnostic.message.includes('current value is 20')));
});

test('unknown initial macros do not release a wait; numeric initial values do', () => {
  const source = [wait('initial-wait', 501, 10), block('cut', 'G1 X10 F600')];
  const unknown = estimateCycle(source, []);
  assert.equal(unknown.complete, false);
  assert.equal(unknown.duration, 0);
  const known = estimateCycle(source, [], { initialMacros: { '#501': '10.0' } });
  assert.equal(known.complete, true);
  near(known.duration, 1);
});

test('mismatched barrier order is reported without scheduling impossible progress', () => {
  const result = estimateCycle([barrier('ha', 'A'), barrier('hb', 'B')], [barrier('vb', 'B'), barrier('va', 'A')]);
  assert.equal(result.complete, false);
  assert.equal(result.duration, 0);
  assert.equal(result.diagnostics.filter(diagnostic => diagnostic.code === 'synchronization-stalled').length, 2);
});

test('a barrier combined with motion is flagged rather than silently dropping its travel', () => {
  const mixed = { ...barrier('mixed'), text: 'G1 X100 F600 M301P12', sync: { ...barrier('unused').sync, code: 'M301P12' } };
  const result = estimateCycle([mixed], [barrier('other')]);
  assert.equal(result.complete, false);
  assert.equal(result.blockTimes.mixed.unknown, true);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.message.includes('shares a line')));
});

test('same-time macro overwrites settle before waits and uncertain concurrent writes are flagged', () => {
  const transient = estimateCycle([signal('first', 501, 10), signal('second', 501, 20)], [wait('consumer', 501, 10)]);
  assert.equal(transient.complete, false);
  assert.ok(transient.diagnostics.some(diagnostic => diagnostic.code === 'transient-macro-value'));
  const concurrent = estimateCycle([signal('h-set', 501, 10)], [signal('v-set', 501, 20)]);
  assert.equal(concurrent.complete, false);
  assert.ok(concurrent.diagnostics.some(diagnostic => diagnostic.code === 'concurrent-macro-write'));
});

test('literal WHILE / END and assignments work even without pre-parsed synchronization objects', () => {
  const result = estimateCycle([block('set', '#501=20')], [block('wait', 'WHILE[#501NE20]DO1\nEND1'), block('cut', 'G1 X60 F600')]);
  assert.equal(result.complete, true);
  near(result.duration, 6);
});

test('opaque control flow and non-per-minute feed do not produce confident timing', () => {
  const result = estimateCycle([block('loop', 'WHILE[#1LT2]DO1\nG1 X10 F600\nEND1'), block('feed', 'G95 G1 X20 F0.1'), block('dwell', 'G4 P1000')], []);
  assert.equal(result.complete, false);
  assert.ok(result.blockTimes.loop.unknown);
  assert.ok(result.blockTimes.feed.unknown);
  assert.ok(result.blockTimes.dwell.unknown);
});

test('all channel category totals equal the shared duration', () => {
  const result = estimateCycle([block('h', 'G1 X100 F600'), barrier('ha'), block('h-end', 'M6')], [block('v', 'G0 X100\nG1 X150 F600'), barrier('va')]);
  for (const channel of Object.values(result.channels)) near(channel.cut + channel.air + channel.toolChange + channel.wait, channel.total);
  for (const channel of ['h', 'v']) assert.ok(result.segments[channel].every(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end >= segment.start));
});

test('M30 stops the channel and prevents unreachable macro releases or manual durations', () => {
  const h = [block('before-end', 'G1 X10 F600\nM30'), signal('unreachable-signal', 501, 20), block('unreachable-path', 'G1 X100 F600')];
  const v = [wait('blocked', 501, 20)];
  const result = estimateCycle(h, v, {}, { 'unreachable-path': 100 });
  near(result.duration, 1);
  near(result.channels.h.cut, 1);
  assert.equal(result.complete, false);
  assert.equal(result.blockTimes['unreachable-path'].duration, 0);
  assert.equal(result.segments.h.some(segment => segment.blockId === 'unreachable-signal'), false);
  assert.equal(result.diagnostics.filter(diagnostic => diagnostic.code === 'after-program-end').length, 2);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'synchronization-stalled' && diagnostic.message.includes('current value is unknown')));
});

test('executable lines after M2 within one block are ignored and diagnosed', () => {
  const result = estimateCycle([block('mixed-end', 'G1 X10 F600\nN10 M02\nG1 X100 F600\n#501=20\n%')], []);
  near(result.duration, 1);
  assert.equal(result.complete, false);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'after-program-end'));
  assert.equal(result.segments.h.some(segment => segment.type === 'signal'), false);
});

test('closing percent, comments and empty N labels after program end are harmless', () => {
  const result = estimateCycle([block('program', 'G1 X10 F600\nM30\n(closing comment)\n%'), block('tail', '; M6 X999\nN10\n%\n')], []);
  near(result.duration, 1);
  assert.equal(result.complete, true);
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 'after-program-end'), false);
});

test('combined coverage merges overlapping cutting intervals without double counting', () => {
  const result = estimateCycle([block('h-cut', 'G1 X100 F600')], [block('v-cut', 'G1 Y100 F600')]);
  near(result.duration, 10);
  near(result.coverage.cutting, 10);
  near(result.coverage.simultaneous, 10);
  near(result.coverage.nonCutting, 0);
  near(result.coverage.utilization, 1);
});

test('combined coverage counts periods with either spindle cutting and exposes real gaps', () => {
  const result = estimateCycle(
    [block('h-pattern', 'G1 X100 F600\nG0 X200\nG1 X300')],
    [block('v-pattern', 'G0 X50\nG1 X150 F600\nG0 X250\nG1 X350')],
    { rapidFeed: 600 },
  );
  near(result.duration, 35);
  near(result.channels.h.cut + result.channels.v.cut, 40);
  near(result.coverage.cutting, 30);
  near(result.coverage.simultaneous, 10);
  near(result.coverage.nonCutting, 5);
  near(result.coverage.utilization, 30 / 35);
});

test('empty cycles return finite zero coverage metrics', () => {
  assert.deepEqual(estimateCycle([], []).coverage, { cutting: 0, nonCutting: 0, simultaneous: 0, utilization: 0 });
});

test('unsafe integer macro literals cannot collapse into a false release', () => {
  const result = estimateCycle(
    [signal('unsafe-set', 501, '9007199254740992')],
    [wait('unsafe-wait', 501, '9007199254740993'), block('must-not-run', 'G1 X100 F600')],
  );
  assert.equal(result.complete, false);
  assert.equal(result.segments.v.some(segment => segment.blockId === 'must-not-run'), false);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'unknown-block-time' && diagnostic.message.includes('precision bounds')));
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'synchronization-stalled'));
});

test('excess decimal precision is rejected before numeric conversion loses a distinction', () => {
  const result = estimateCycle([signal('rounded-set', 501, '1.0000000000000001')], [wait('ordinary-wait', 501, '1'), block('must-not-run', 'G1 X100 F600')]);
  assert.equal(result.complete, false);
  assert.equal(result.segments.v.some(segment => segment.blockId === 'must-not-run'), false);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'unknown-block-time'));
});

test('unsafe initial macro values remain unknown and supported equivalent literals still match', () => {
  const unsafe = estimateCycle([wait('wait', 501, '1')], [], { initialMacros: { 501: 9007199254740992 } });
  assert.equal(unsafe.complete, false);
  assert.ok(unsafe.diagnostics.some(diagnostic => diagnostic.code === 'unsupported-initial-macro'));
  const supported = estimateCycle([signal('set', 501, '0001.23000')], [wait('wait', 501, '1.23'), block('cut', 'G1 X10 F600')]);
  assert.equal(supported.complete, true);
  near(supported.duration, 1);
});
