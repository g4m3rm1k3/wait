import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePathEnvelopes as analyzeRaw } from '../src/sync/path-envelopes.js';

// Ordinary fixtures establish machine modes explicitly; startup-mode tests below
// use the raw API so missing units/distance mode cannot be hidden by a helper.
const analyzePathEnvelopes = (sources, settings) => analyzeRaw(Object.fromEntries(Object.entries(sources).map(([channel, source]) => [channel, `G21 G90\n${source}`])), settings);

const profile = (h = { x: 0, y: 0, z: 0 }, v = { x: 100, y: 0, z: 0 }, clearance = 1) => ({ pathGeometry: { sharedFrame: true, clearance, initialPositions: { h, v } } });

test('crossing complete swept paths are reported even when their endpoints differ', () => {
  const result = analyzePathEnvelopes({ h: 'G90 G1 X10 Y10 Z0\nN10\nM30', v: 'G90 G1 X10 Y0 Z0\nN20\nM30' }, profile({ x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }, 0));
  assert.equal(result.conflicts[0].kind, 'possible-overlap');
  assert.equal(result.conflicts[0].clear, false);
  assert.deepEqual(result.operations.h[0].bounds, { x: [0, 10], y: [0, 10], z: [0, 0] });
});

test('known paths separated on any axis can clear only with the common frame and full clearance', () => {
  const sources = { h: 'G0 X10 Y0 Z0\nN1', v: 'G0 X110 Y0 Z0\nN2' };
  const result = analyzePathEnvelopes(sources, profile());
  assert.equal(result.complete, true);
  assert.equal(result.conflicts[0].kind, 'separated');
  assert.equal(result.conflicts[0].clear, true);
  assert.equal(analyzePathEnvelopes(sources).complete, false);
  assert.equal(analyzePathEnvelopes(sources).conflicts[0].clear, false);
});

test('clearance expands the comparison and touching bounds count as possible overlap', () => {
  const sources = { h: 'G1 X10\nN1', v: 'G1 X21\nN2' };
  const settings = profile({ x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }, 10);
  assert.equal(analyzePathEnvelopes(sources, settings).conflicts[0].kind, 'possible-overlap');
});

test('modal linear motion, incremental coordinates and inches produce millimeter bounds', () => {
  const result = analyzePathEnvelopes({ h: 'G20 G91 G1 X1\nY2\nX-0.5\nN10\nG21 G90\nZ10\nN20', v: 'G1 X110\nN1' }, profile());
  assert.equal(result.operations.h.length, 2);
  assert.deepEqual(result.operations.h[0].bounds, { x: [0, 25.4], y: [0, 50.8], z: [0, 0] });
  assert.deepEqual(result.operations.h[1].bounds.z, [0, 10]);
  assert.deepEqual(result.operations.h.map((op) => op.n), ['N10', 'N20']);
});

test('rapid approaches and retracts remain part of the complete path envelope', () => {
  const result = analyzePathEnvelopes({ h: 'G0 X50 Z50\nG1 Z-10\nG0 Z200\nN1', v: 'G0 X110\nN2' }, profile());
  assert.deepEqual(result.operations.h[0].bounds, { x: [0, 50], y: [0, 0], z: [-10, 200] });
});

test('matching work offsets expose possible overlaps without claiming geometry is known', () => {
  const result = analyzePathEnvelopes({ h: 'G54 G0 X0 Y0 Z0\nG1 X10\nN1', v: 'G54 G0 X10 Y0 Z0\nG1 X0\nN2' });
  assert.equal(result.operations.h[0].workOffset, 'G54');
  assert.equal(result.operations.v[0].frame, 'G54');
  assert.equal(result.conflicts[0].kind, 'possible-overlap');
  assert.equal(result.conflicts[0].clear, false);
  assert.equal(result.complete, false);
});

test('same stable work offset and configured geometry can separate, differing offsets cannot', () => {
  const sources = { h: 'G54 G1 X10\nN1', v: 'G54 G1 X110\nN2' };
  assert.equal(analyzePathEnvelopes(sources, profile()).conflicts[0].kind, 'separated');
  sources.v = 'G55 G1 X110\nN2';
  assert.equal(analyzePathEnvelopes(sources, profile()).conflicts[0].kind, 'unresolved');
});

test('B positions, G53 and G68/G69 transforms cannot certify separation', () => {
  for (const prefix of ['G0 B90\n', 'G53 G0 X5\n', 'G68 X0 Y0 R90\n', 'G69\n']) {
    const result = analyzePathEnvelopes({ h: `${prefix}G54 G1 X10 Y0 Z0\nN1`, v: 'G54 G1 X110\nN2' }, profile());
    assert.equal(result.conflicts[0].clear, false, prefix);
    assert.equal(result.conflicts[0].kind, 'unresolved', prefix);
    assert.ok(result.operations.h[0].unresolved.length, prefix);
  }
});

test('unknown initial motion, arcs, cycles, compensation and subprograms retain uncertainty', () => {
  const start = analyzePathEnvelopes({ h: 'G0 X0 Y0 Z0\nG1 X10\nN1', v: 'G1 X110\nN2' }, { pathGeometry: { sharedFrame: true, clearance: 1 } });
  assert.match(start.operations.h[0].unresolved.join(' '), /starting tool position is unknown/);
  for (const code of ['G2 X10 Y10 I5 J5', 'G81 X10 Y10 Z-5 R2', 'G43 H1 Z10', 'M98 P1000', 'IF[#100EQ1]GOTO20', 'G1 X#100']) {
    const result = analyzePathEnvelopes({ h: `${code}\nN1`, v: 'G1 X110\nN2' }, profile());
    assert.equal(result.complete, false, code);
    assert.equal(result.conflicts[0].clear, false, code);
  }
});

test('active tool and B metadata carry forward in source order without altering inputs', () => {
  const sources = { h: 'T7\nG0 B90 X1 Y2 Z3\nN9\nG1 X4\nN2', v: 'G1 X110\nN1' };
  const settings = profile();
  const snapshot = structuredClone({ sources, settings });
  const result = analyzePathEnvelopes(sources, settings);
  assert.deepEqual(result.operations.h.map((op) => [op.event, op.n, op.tool, op.b]), [[1, 'N9', 7, 90], [2, 'N2', 7, 90]]);
  assert.deepEqual({ sources, settings }, snapshot);
});

test('stationary synchronization macros are ignored but motion inside WHILE stays unresolved', () => {
  const sync = '#501=1\nWHILE[#502NE1]DO1\nG4P100\nEND1\nM301P12\n';
  const sources = { h: `${sync}G1 X10\nN1`, v: 'M301P12\nG1 X110\nN2' };
  assert.equal(analyzePathEnvelopes(sources, profile()).conflicts[0].kind, 'separated');
  sources.h = 'WHILE[#502NE1]DO1\nG0 X50\nEND1\nG1 X10\nN1';
  assert.equal(analyzePathEnvelopes(sources, profile()).conflicts[0].clear, false);
});

test('footer motion is analyzed and code after program end never becomes a clear path', () => {
  const result = analyzePathEnvelopes({ h: 'G1 X10\nN1\nG0 Z100\nM30\nG0 X999', v: 'G1 X110\nN2\nM30' }, profile());
  assert.equal(result.operations.h.length, 2);
  assert.equal(result.operations.h[1].n, null);
  assert.deepEqual(result.operations.h[1].bounds.z, [0, 100]);
  assert.equal(result.complete, false);
  assert.match(result.notes.join(' '), /after M2\/M30/);
});

test('operation-pair reporting is capped with an explicit incomplete report', () => {
  const channel = Array.from({ length: 101 }, (_, index) => `G1 X${index}\nN${index}`).join('\n');
  const result = analyzePathEnvelopes({ h: channel, v: channel }, profile());
  assert.equal(result.conflicts.length, 10000);
  assert.equal(result.complete, false);
  assert.match(result.notes.join(' '), /10,000 operation pairs/);
});

test('the shared Y profile permits separated spindle paths with only initial Y positions known', () => {
  const settings = { pathGeometry: { sharedAxis: 'y', clearance: 5, initialPositions: { h: { y: 0 }, v: { y: 30 } } } };
  const result = analyzePathEnvelopes({ h: 'G54 G90 G1 X100\nY2\nN1\nM30', v: 'G54 G90 G1 X-100\nY25\nN2\nM30' }, settings);
  assert.equal(result.complete, true);
  assert.equal(result.operations.h.length, 1);
  assert.equal(result.operations.v.length, 1);
  assert.equal(result.operations.h[0].bounds, null);
  assert.deepEqual(result.operations.h[0].yRange, [0, 2]);
  assert.deepEqual(result.operations.v[0].yRange, [25, 30]);
  assert.equal(result.conflicts[0].axis, 'y');
  assert.equal(result.conflicts[0].kind, 'separated');
  assert.equal(result.conflicts[0].clear, true);
});

test('shared Y overlap cannot be excused by distant differently oriented X and Z axes', () => {
  const settings = { pathGeometry: { sharedAxis: 'y', clearance: 5, initialPositions: { h: { x: -1000, y: 0, z: -1000 }, v: { x: 1000, y: 20, z: 1000 } } } };
  const result = analyzePathEnvelopes({ h: 'G1 Y15\nN1', v: 'G1 Y10\nN2' }, settings);
  assert.equal(result.conflicts[0].kind, 'possible-overlap');
  assert.deepEqual(result.operations.h[0].yRange, [0, 15]);
  assert.deepEqual(result.operations.v[0].yRange, [10, 20]);
});

test('shared Y intervals include incremental inch approach and retract sweeps', () => {
  const settings = { pathGeometry: { sharedAxis: 'y', clearance: 1, initialPositions: { h: { y: 0 }, v: { y: 100 } } } };
  const result = analyzePathEnvelopes({ h: 'G20 G91 G0 Y1\nG1 Y-2\nG0 Y3\nN1', v: 'G21 G90 G1 Y110\nN2' }, settings);
  assert.deepEqual(result.operations.h[0].yRange, [-25.4, 50.79999999999999]);
  assert.equal(result.conflicts[0].kind, 'separated');
});

test('unknown starting Y, different offsets and active rotations never clear in shared Y mode', () => {
  const settings = { pathGeometry: { sharedAxis: 'y', clearance: 5, initialPositions: { v: { y: 100 } } } };
  const initial = analyzePathEnvelopes({ h: 'G54 G1 Y0\nN1', v: 'G54 G1 Y110\nN2' }, settings);
  assert.equal(initial.conflicts[0].clear, false);
  assert.match(initial.operations.h[0].unresolved.join(' '), /starting Y position/);
  settings.pathGeometry.initialPositions.h = { y: 0 };
  for (const prefix of ['G55', 'G54 G0 B90\n', 'G54 G68 R90\n']) {
    const result = analyzePathEnvelopes({ h: `${prefix}\nG1 Y0\nN1`, v: 'G54 G1 Y110\nN2' }, settings);
    assert.equal(result.conflicts[0].clear, false, prefix);
  }
});

test('compensation, unmodeled frames and canned cycles remain unresolved across later operations', () => {
  for (const prefix of ['G41', 'G42', 'G43 H1', 'G44 H1', 'G51', 'G52 X1', 'G92 X1', 'G81 X5 Y0 Z-5']) {
    const result = analyzePathEnvelopes({ h: `G1 X0 Y0 Z0\n${prefix}\nN1\nG1 X0 Y0 Z0\nN2\nG1 X10\nN3`, v: 'G1 X110\nN9' }, profile());
    assert.equal(result.conflicts.find((pair) => pair.hEvent === 3).clear, false, prefix);
    assert.ok(result.operations.h[2].unresolved.length, prefix);
  }
});

test('ending N lines with executable motion match the editor operation boundaries', () => {
  const result = analyzePathEnvelopes({ h: 'G1 X1\nN10 G1 X2\nG1 X3\nN20 G1 X4\nM30', v: 'G1 X110\nN1' }, profile());
  assert.deepEqual(result.operations.h.map((op) => [op.event, op.n, op.bounds.x]), [[1, 'N10', [0, 2]], [2, 'N20', [2, 4]]]);
  assert.equal(result.operations.h.length, 2);
});

test('cancelling compensation at the end of an operation does not erase its earlier unresolved sweep', () => {
  const result = analyzePathEnvelopes({ h: 'G1 X0 Y0 Z0\nG41\nN1\nG1 X10\nG40\nN2', v: 'G1 X110\nN9' }, profile());
  assert.equal(result.conflicts.find((pair) => pair.hEvent === 2).clear, false);
});

test('startup units and distance mode must both be explicit before a path can clear', () => {
  for (const setup of ['', 'G21\n', 'G90\n']) {
    const result = analyzeRaw({ h: `${setup}G1 X10\nN1`, v: 'G21 G90\nG1 X110\nN2' }, profile());
    assert.equal(result.conflicts[0].clear, false, setup);
    assert.match(result.operations.h[0].unresolved.join(' '), /G20\/G21 units and G90\/G91/);
  }
  assert.equal(analyzeRaw({ h: 'G21 G90\nG1 X10\nN1', v: 'G21 G90\nG1 X110\nN2' }, profile()).conflicts[0].clear, true);
});

test('operations expose the exact same decoded segments used to form their bounds', () => {
  const settings = { pathGeometry: { sharedAxis: 'y', clearance: 5, initialPositions: { h: { y: 0 }, v: { y: 30 } } } };
  const result = analyzeRaw({ h: 'G21 G90\nG54 G0 Y2\nG1 Y5\nY-1\nN10', v: 'G21 G90\nG54 G1 Y40\nN20' }, settings);
  const op = result.operations.h[0];
  assert.deepEqual(op.yRange, [-1, 5]);
  assert.deepEqual(op.segments.map((segment) => [segment.line, segment.motion, segment.start.y, segment.end.y, segment.workOffset]), [[2, 'rapid', 0, 2, 'G54'], [3, 'feed', 2, 5, 'G54'], [4, 'feed', 5, -1, 'G54']]);
  assert.deepEqual(op.segments[0].start, { x: null, y: 0, z: null });
  assert.equal(op.segments[0].source, 'G54 G0 Y2');
});

test('macro and unsupported motion segments remain unknown for a future viewer', () => {
  const result = analyzePathEnvelopes({ h: 'G1 X#100\nG2 X10 Y10 I5 J5\nN1', v: 'G1 X110\nN2' }, profile());
  assert.equal(result.operations.h[0].segments.length, 2);
  assert.ok(result.operations.h[0].segments.every((segment) => segment.motion === 'unknown'));
  assert.deepEqual(result.operations.h[0].segments[0].end, { x: null, y: null, z: null });
});

test('cancellation at the first line of a later operation preserves compensation uncertainty', () => {
  for (const [enable, cancel] of [['G41', 'G40'], ['G43 H1', 'G49']]) {
    const result = analyzePathEnvelopes({ h: `G1 X0 Y0 Z0\n${enable}\nN1\n${cancel} G1 X5 Y0 Z0\nN2\nG1 X10\nN3`, v: 'G1 X110\nN9' }, profile());
    assert.equal(result.conflicts.find((pair) => pair.hEvent === 2).clear, false, enable);
  }
});
