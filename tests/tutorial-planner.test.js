import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { planAll, DEFAULT_SETTINGS } from '../sync-algorithm-k7f2/planner.js';

// The tutorial's JavaScript planner must print the same timeline as the
// Python for every reference case (tools/conformance/cases/*/expected/report.txt).
const CASES = new URL('../tools/conformance/cases/', import.meta.url);

for (const name of readdirSync(CASES)) {
  const report = new URL(`${name}/expected/report.txt`, CASES);
  if (!existsSync(report)) continue;
  const text = readFileSync(report, 'utf8');
  if (!text.includes('(timeline)')) continue;
  test(`tutorial planner matches the Python on ${name}`, () => {
    const settings = Object.fromEntries(
      text.split('\n').filter((line) => line.startsWith('sync_plan.')).map((line) => {
        const [key, value] = line.slice('sync_plan.'.length).split(' = ');
        return [key, value === 'True' ? true : value === 'False' ? false : Number(value)];
      }),
    );
    assert.deepEqual(Object.keys(settings).sort(), Object.keys(DEFAULT_SETTINGS).sort());
    const expected = text.split('(timeline)\n')[1].split('\n\n')[0].split('\n');
    const result = planAll(readFileSync(new URL(`${name}/ops.txt`, CASES), 'utf8'), settings);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.timeline.lines, expected);
  });
}
