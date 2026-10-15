import test from 'node:test';
import assert from 'node:assert/strict';
import { alignChannels } from '../src/alignment.js';

const content = (id) => ({ id, kind: 'toolpath', text: id, sync: null });
const barrier = (id, key) => ({ id, kind: 'sync', text: `M${key}`, sync: { kind: 'barrier', role: 'barrier', key } });
const macro = (id, role, variable, value) => ({ id, kind: 'sync', text: id, sync: { kind: 'macro', role, variable, value, key: `#${variable}=${value}` } });
const sourceOrder = (result, channel) => result.rows.flatMap((row) => row[channel] ? [row[channel].id] : []);
const codes = (result) => result.diagnostics.map((item) => item.code);

test('pairs content around matching barriers without changing either source order', () => {
  const h = [content('h1'), content('h2'), barrier('hb', '301P12'), content('h3')];
  const v = [content('v1'), barrier('vb', '301P12'), content('v2'), content('v3')];
  const result = alignChannels(h, v);
  assert.deepEqual(sourceOrder(result, 'h'), h.map((block) => block.id));
  assert.deepEqual(sourceOrder(result, 'v'), v.map((block) => block.id));
  assert.deepEqual(result.rows.map((row) => [row.h?.id ?? null, row.v?.id ?? null]), [
    ['h1', 'v1'], ['h2', null], ['hb', 'vb'], ['h3', 'v2'], [null, 'v3'],
  ]);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.rows[2].type, 'sync');
  assert.deepEqual(result.diagnostics, []);
});

test('repeated barriers match by occurrence and report missing occurrences', () => {
  const h = [barrier('h1', '301P12'), content('hc'), barrier('h2', '301P12'), barrier('h3', '301P12')];
  const v = [barrier('v1', '301P12'), barrier('v2', '301P12')];
  const result = alignChannels(h, v);
  assert.equal(result.matchedCount, 2);
  assert.deepEqual(result.links.map((link) => [link.hId, link.vId]), [['h1', 'v1'], ['h2', 'v2']]);
  assert.ok(codes(result).includes('barrier-unmatched'));
  assert.match(result.links[1].label, /occurrence 2/);
  assert.deepEqual(sourceOrder(result, 'h'), h.map((block) => block.id));
});

test('crossed barriers report a deadlock and still render each block once in source order', () => {
  const h = [barrier('ha', '301P12'), content('hc'), barrier('hb', '302P12')];
  const v = [barrier('vb', '302P12'), content('vc'), barrier('va', '301P12')];
  const result = alignChannels(h, v);
  assert.ok(codes(result).includes('sync-cycle'));
  assert.equal(result.matchedCount, 1);
  assert.equal(result.links.length, 2);
  assert.equal(result.links.filter((link) => link.aligned).length, 1);
  assert.deepEqual(sourceOrder(result, 'h'), h.map((block) => block.id));
  assert.deepEqual(sourceOrder(result, 'v'), v.map((block) => block.id));
});

test('empty and uneven channels retain all content', () => {
  assert.deepEqual(alignChannels([], []).rows, []);
  const result = alignChannels([], [content('v1'), content('v2')]);
  assert.deepEqual(result.rows.map((row) => row.h), [null, null]);
  assert.deepEqual(sourceOrder(result, 'v'), ['v1', 'v2']);
});

test('macro assignment aligns with the opposite wait in either direction', () => {
  const h = [macro('hs', 'signal', '501', '100'), content('hc'), macro('hw', 'wait', '502', '200')];
  const v = [macro('vw', 'wait', '501', '100'), content('vc'), macro('vs', 'signal', '502', '200')];
  const result = alignChannels(h, v);
  assert.equal(result.matchedCount, 2);
  assert.deepEqual(result.links.map(({ signalId, waitId, producer }) => ({ signalId, waitId, producer })), [
    { signalId: 'hs', waitId: 'vw', producer: 'h' },
    { signalId: 'vs', waitId: 'hw', producer: 'v' },
  ]);
  assert.ok(codes(result).includes('macro-static-only'));
  assert.ok(!codes(result).includes('macro-dependency-cycle'));
});

test('repeated macro assignments remain ambiguous instead of inventing a match', () => {
  const h = [macro('hs1', 'signal', '501', '100'), macro('hs2', 'signal', '501', '100')];
  const v = [macro('vw', 'wait', '501', '100')];
  const result = alignChannels(h, v);
  assert.equal(result.matchedCount, 0);
  assert.equal(result.links.length, 0);
  assert.ok(codes(result).includes('macro-ambiguous'));
  assert.deepEqual(sourceOrder(result, 'h'), ['hs1', 'hs2']);
});

test('unresolved waits warn that source state may come from elsewhere', () => {
  const result = alignChannels([macro('hw', 'wait', '501', '100')], []);
  assert.ok(codes(result).includes('macro-unresolved-wait'));
  assert.equal(result.matchedCount, 0);
});

test('producer overwrite flags a potentially missed equality value', () => {
  const h = [macro('hs1', 'signal', '501', '100'), content('hc'), macro('hs2', 'signal', '501', '200')];
  const v = [macro('vw', 'wait', '501', '100')];
  const result = alignChannels(h, v);
  assert.ok(codes(result).includes('macro-equality-race'));
});

test('a barrier after the wait protects a later producer overwrite', () => {
  const h = [macro('hs1', 'signal', '501', '100'), barrier('hb', '301P12'), macro('hs2', 'signal', '501', '200')];
  const v = [macro('vw', 'wait', '501', '100'), barrier('vb', '301P12')];
  const result = alignChannels(h, v);
  assert.ok(!codes(result).includes('macro-equality-race'));
});

test('opposed signals before waits are visually crossed but do not imply a macro deadlock', () => {
  const h = [macro('hs', 'signal', '501', '100'), macro('hw', 'wait', '502', '100')];
  const v = [macro('vs', 'signal', '502', '100'), macro('vw', 'wait', '501', '100')];
  const result = alignChannels(h, v);
  assert.ok(codes(result).includes('macro-visual-conflict'));
  assert.ok(!codes(result).includes('macro-dependency-cycle'));
  assert.ok(!codes(result).includes('sync-cycle'));
  assert.deepEqual(sourceOrder(result, 'h'), ['hs', 'hw']);
  assert.deepEqual(sourceOrder(result, 'v'), ['vs', 'vw']);
});

test('waits before both needed signals identify a possible dependency deadlock', () => {
  const h = [macro('hw', 'wait', '502', '100'), macro('hs', 'signal', '501', '100')];
  const v = [macro('vw', 'wait', '501', '100'), macro('vs', 'signal', '502', '100')];
  const result = alignChannels(h, v);
  assert.ok(codes(result).includes('macro-dependency-cycle'));
  assert.deepEqual(sourceOrder(result, 'h'), ['hw', 'hs']);
  assert.deepEqual(sourceOrder(result, 'v'), ['vw', 'vs']);
});

test('visual anchors prioritize barriers over crossing macro links', () => {
  const h = [macro('hs', 'signal', '501', '100'), barrier('hb', '301P12')];
  const v = [barrier('vb', '301P12'), macro('vw', 'wait', '501', '100')];
  const result = alignChannels(h, v);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.links.find((link) => link.kind === 'barrier').aligned, true);
  assert.equal(result.links.find((link) => link.kind === 'macro').aligned, false);
  assert.ok(codes(result).includes('macro-visual-conflict'));
});

test('options can retain directional links without using them as visual anchors', () => {
  const result = alignChannels([macro('hs', 'signal', '501', '100')], [macro('vw', 'wait', '501', '100')], { includeMacroAnchors: false });
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].aligned, false);
  assert.equal(result.matchedCount, 0);
  assert.ok(!codes(result).includes('macro-visual-conflict'));
});

test('numeric macro spelling is normalized across channels', () => {
  const result = alignChannels([macro('hs', 'signal', '#0501', '+001.0')], [macro('vw', 'wait', '501', '1')]);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.links[0].key, '#501=1');
});

test('large distinct macro values are not collapsed by floating point conversion', () => {
  const result = alignChannels([macro('hs', 'signal', '501', '9007199254740993')], [macro('vw', 'wait', '501', '9007199254740992')]);
  assert.equal(result.matchedCount, 0);
  assert.ok(codes(result).includes('macro-unresolved-wait'));
});

test('both channels writing a shared macro raises a warning', () => {
  const result = alignChannels([macro('hs', 'signal', '501', '100')], [macro('vs', 'signal', '501', '200')]);
  assert.ok(codes(result).includes('macro-multiple-writers'));
});
