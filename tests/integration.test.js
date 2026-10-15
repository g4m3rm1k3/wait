import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProgram } from '../src/nc/parser.js';
import { serializeProgram, moveBlock } from '../src/nc/edit.js';
import { alignChannels } from '../src/sync/alignment.js';
import { estimateCycle } from '../src/timing/estimate.js';
import { DEMO } from '../src/nc/demo-programs.js';

function parsePair(sources = DEMO, settings = {}) {
  return {
    h: parseProgram(sources.h, settings, 'h').blocks,
    v: parseProgram(sources.v, settings, 'v').blocks,
  };
}
const rowIds = (alignment, channel) => alignment.rows.filter((row) => row[channel]).map((row) => row[channel].id);
const hasCode = (result, code) => result.diagnostics.some((item) => item.code === code);

test('demo parser, alignment and timing contracts agree without altering NC source', () => {
  const pair = parsePair();
  const before = JSON.stringify(pair);
  const alignment = alignChannels(pair.h, pair.v);
  const timing = estimateCycle(pair.h, pair.v);
  assert.equal(alignment.matchedCount, 6);
  assert.equal(alignment.links.filter((link) => link.kind === 'barrier').length, 4);
  assert.equal(alignment.links.filter((link) => link.kind === 'macro').length, 2);
  assert.ok(!alignment.diagnostics.some((item) => item.level === 'error'));
  for (const channel of ['h', 'v']) {
    assert.equal(serializeProgram(pair[channel]), DEMO[channel]);
    assert.deepEqual(rowIds(alignment, channel), pair[channel].map((block) => block.id));
    assert.ok(pair[channel].every((block) => typeof timing.blockTimes[block.id].duration === 'number'));
  }
  assert.equal(JSON.stringify(pair), before);
  assert.equal(timing.complete, false);
  assert.ok(hasCode(timing, 'unknown-block-time'));
});

test('manual demo operation times resolve the estimate and expose vertical work during horizontal tool change', () => {
  const pair = parsePair();
  const provisional = estimateCycle(pair.h, pair.v);
  const overrides = Object.fromEntries(provisional.diagnostics.filter((item) => item.code === 'unknown-block-time').flatMap((item) => item.blockIds.map((id) => [id, 3])));
  const result = estimateCycle(pair.h, pair.v, {}, overrides);
  assert.equal(result.complete, true);
  assert.ok(!hasCode(result, 'unknown-block-time'));
  const hChange = pair.h.find((block) => block.title.startsWith('TOOL CHANGE / T02'));
  const vFeature = pair.v.find((block) => block.title.startsWith('SMALL FEATURE'));
  const changes = result.segments.h.filter((segment) => segment.blockId === hChange.id && segment.type === 'toolChange');
  const featureWork = result.segments.v.filter((segment) => segment.blockId === vFeature.id && segment.type === 'cut');
  assert.ok(changes.length > 0);
  assert.ok(featureWork.length > 0);
  assert.ok(changes.some((change) => featureWork.some((feature) => Math.min(change.end, feature.end) > Math.max(change.start, feature.start))));
  for (const channel of ['h', 'v']) {
    const stats = result.channels[channel];
    assert.ok(Math.abs(stats.cut + stats.air + stats.toolChange + stats.wait - result.duration) < 1e-7);
    assert.ok(stats.utilization >= 0 && stats.utilization <= 1);
  }
});

test('a macro signal releases the consumer without holding the producer at the visual alignment row', () => {
  const pair = parsePair({
    h: '%\nO1001\n#501=10\nT2 M6\nN10\nG21 G90 G1 X100 F600\nN20\nM301P12\nM30\n%\n',
    v: '%\nO2001\nWHILE[#501NE10]DO1\nEND1\nG21 G90 G1 X40 F600\nN110\nM301P12\nM30\n%\n',
  });
  const alignment = alignChannels(pair.h, pair.v);
  const timing = estimateCycle(pair.h, pair.v);
  assert.equal(alignment.matchedCount, 2);
  assert.equal(timing.complete, true);
  assert.equal(timing.duration, 18);
  const toolChange = timing.segments.h.find((segment) => segment.type === 'toolChange');
  const verticalCut = timing.segments.v.find((segment) => segment.type === 'cut');
  assert.deepEqual([toolChange.start, toolChange.end], [0, 8]);
  assert.deepEqual([verticalCut.start, verticalCut.end], [0, 4]);
  assert.equal(timing.channels.v.wait, 14);
});

test('a crossed barrier order is diagnosed consistently by alignment and the event estimate', () => {
  const pair = parsePair({ h: 'M301P12\nM302P12\n', v: 'M302P12\nM301P12\n' });
  const before = JSON.stringify(pair);
  const alignment = alignChannels(pair.h, pair.v);
  const timing = estimateCycle(pair.h, pair.v);
  assert.ok(hasCode(alignment, 'sync-cycle'));
  assert.ok(hasCode(timing, 'synchronization-stalled'));
  assert.equal(timing.complete, false);
  assert.equal(JSON.stringify(pair), before);
  for (const channel of ['h', 'v']) assert.deepEqual(rowIds(alignment, channel), pair[channel].map((block) => block.id));
});

test('the participant matching option flows from parsing to both alignment and scheduling', () => {
  const sources = { h: 'M301P12\n', v: 'M301P21\n' };
  const exact = parsePair(sources);
  assert.equal(alignChannels(exact.h, exact.v).matchedCount, 0);
  assert.equal(estimateCycle(exact.h, exact.v).complete, false);
  const ignored = parsePair(sources, { waitParticipantMode: 'ignore' });
  assert.equal(alignChannels(ignored.h, ignored.v).matchedCount, 1);
  assert.equal(estimateCycle(ignored.h, ignored.v).complete, true);
});

test('moving a parsed wait preserves its source text and both display source orders', () => {
  const pair = parsePair();
  const index = pair.h.findIndex((block) => block.sync?.kind === 'barrier');
  const moved = moveBlock(pair.h, index, index + 2);
  assert.equal(moved[index + 1].id, pair.h[index].id);
  assert.deepEqual([...moved].sort((a, b) => a.id.localeCompare(b.id)).map((block) => block.text), [...pair.h].sort((a, b) => a.id.localeCompare(b.id)).map((block) => block.text));
  const reparsed = parseProgram(serializeProgram(moved), {}, 'h').blocks;
  assert.equal(serializeProgram(reparsed), serializeProgram(moved));
  const alignment = alignChannels(reparsed, pair.v);
  assert.deepEqual(rowIds(alignment, 'h'), reparsed.map((block) => block.id));
  assert.deepEqual(rowIds(alignment, 'v'), pair.v.map((block) => block.id));
});
