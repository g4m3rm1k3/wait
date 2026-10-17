import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_WAIT_MARKER, clearWaitCodes } from '../src/sync/wait-codes.js';

const recognized = (source, settings = {}) => clearWaitCodes(source, settings, { scope: 'recognized' });

test('default clearing removes only standalone owned waits and preserves every remaining byte', () => {
  const source = `%\r\nO1001\nT1\rM301P12 (${AUTO_WAIT_MARKER} 1 OPEN)\r\nG1 X20 F600\nM302P12\r\nM303P12 (${AUTO_WAIT_MARKER} 2 CLOSE)\nM30\r\n%`;
  const cleared = clearWaitCodes(source);
  assert.equal(cleared.source, '%\r\nO1001\nT1\rG1 X20 F600\nM302P12\r\nM30\r\n%');
  assert.equal(cleared.removed, 2);
  assert.deepEqual(cleared.notes, []);
});

test('ownership comments alone, quoted markers, semicolon markers and combined motion are preserved', () => {
  const source = [
    `(${AUTO_WAIT_MARKER} 1)`,
    `M301P12 (documentation (${AUTO_WAIT_MARKER} 1))`,
    `M301P12 ; (${AUTO_WAIT_MARKER} 1)`,
    `M301P12 G0 B90 (${AUTO_WAIT_MARKER} 1)`,
    `N300 M301P12 (${AUTO_WAIT_MARKER} 1)`,
    `(${AUTO_WAIT_MARKER}ISH) M301P12`,
  ].join('\n');
  assert.deepEqual(clearWaitCodes(source), { source, removed: 0, notes: [] });
});

test('generated clearing removes ownership comments while preserving unrelated comments and line endings', () => {
  const source = `  M301P12 (${AUTO_WAIT_MARKER} 1 OPEN) (keep operator note)\r\nM302P12 (${AUTO_WAIT_MARKER} 1 CLOSE) ; keep instruction\nM303 (${AUTO_WAIT_MARKER} 2 OPEN) P12 (keep embedded note)\r`;
  const cleared = clearWaitCodes(source);
  assert.equal(cleared.source, '    (keep operator note)\r\n  ; keep instruction\n (keep embedded note)\r');
  assert.equal(cleared.removed, 3);
});

test('recognized clearing removes only wait text from combined lines and retains labels and comments', () => {
  const source = 'N20 G1 X25 M301P12 F500 (keep M302P12)\r\nM303P12 ; WAIT FOR H\nG0 Z200\rM304P12';
  const cleared = recognized(source);
  assert.equal(cleared.source, 'N20 G1 X25  F500 (keep M302P12)\r\n ; WAIT FOR H\nG0 Z200\r');
  assert.equal(cleared.removed, 3);
});

test('recognized clearing handles repeated waits on a line without deleting surrounding source', () => {
  const cleared = recognized('G0 X5 M301P12 M302 P12 M301P12 Y8\nM303P12 M304P12\n');
  assert.equal(cleared.source, 'G0 X5    Y8\n');
  assert.equal(cleared.removed, 5);
});

test('both scopes honor custom wait patterns and case insensitive ownership', () => {
  const settings = { waitPattern: '\\bM(2\\d{2})\\b' };
  const source = 'm201 (spindle sync auto 1)\r\nM301P12\r\nM202';
  assert.equal(clearWaitCodes(source, settings).source, 'M301P12\r\nM202');
  assert.equal(recognized(source, settings).source, 'M301P12\r\n');
});

test('commented waits are never recognized including nested and multiline comments', () => {
  const source = '(M301P12)\n; M302P12\n(outer (M303P12)\nM304P12\nend)\nM305P12\n';
  const cleared = recognized(source);
  assert.equal(cleared.source, '(M301P12)\n; M302P12\n(outer (M303P12)\nM304P12\nend)\n');
  assert.equal(cleared.removed, 1);
});

test('removing waits never removes multiline comment boundaries or comments inside a regex match', () => {
  const source = 'M301 (keep this) P12\r\nM302P12 (open\nM303P12\nclose) M304P12\n';
  const cleared = recognized(source);
  assert.equal(cleared.source, '(keep this)\r\n (open\nM303P12\nclose) \n');
  assert.equal(cleared.removed, 3);
});

test('owned waits on lines carrying multiline comment delimiters stay intact by default', () => {
  const source = `(open\nclose) M301P12 (${AUTO_WAIT_MARKER} 1)\nM302P12 (${AUTO_WAIT_MARKER} 2) (open\nclose)\n`;
  assert.equal(clearWaitCodes(source).source, source);
  assert.equal(clearWaitCodes(source).removed, 0);
});

test('macro assignments and WHILE blocks are retained with a count even in recognized scope', () => {
  const macro = '#501=1 (SYNC V CLEAR)\nWHILE[#502NE1]DO1\nM301P12\nG4P100\nEND1\n#502=0 M302P12\n';
  const cleared = recognized(macro + 'M303P12\n');
  assert.equal(cleared.source, macro);
  assert.equal(cleared.removed, 1);
  assert.equal(cleared.notes.length, 1);
  assert.match(cleared.notes[0], /2 macro assignment line\(s\) and 1 WHILE block\(s\)/);
});

test('nested, unclosed and unsupported WHILE code stays together', () => {
  for (const source of [
    'WHILE[#100LT3]DO1\nWHILE[#101LT3]DO2\nM301P12\nEND2\nEND1\n',
    'WHILE[#501NE1]DO1\nM301P12\n',
    'WHILE[#501NE1]\nM301P12\nEND1\n',
  ]) assert.equal(recognized(source).source, source);
});

test('waits on conditional or branch control-flow lines stay intact with a note', () => {
  const protectedSource = `IF[#100EQ1]M301P12\r\nGOTO100 M302P12\nDO1 M303P12 (${AUTO_WAIT_MARKER} 1)\rEND1 M304P12\n`;
  for (const scope of ['generated', 'recognized']) {
    const cleared = clearWaitCodes(protectedSource + `M305P12 (${AUTO_WAIT_MARKER} 2)\n`, {}, { scope });
    assert.equal(cleared.source, protectedSource);
    assert.equal(cleared.removed, 1);
    assert.match(cleared.notes[0], /4 control-flow line\(s\)/);
  }
});

test('empty wait IDs, invalid patterns and long lines fail closed', () => {
  const source = 'M301P12\n';
  for (const waitPattern of ['(', '(M3+)+', 'M301']) {
    const cleared = recognized(source, { waitPattern });
    assert.equal(cleared.source, source);
    assert.equal(cleared.removed, 0);
    assert.match(cleared.notes[0], /kept/i);
  }
  const emptyId = recognized('M P12\n', { waitPattern: '\\bM(3{0}) P(12)\\b' });
  assert.equal(emptyId.source, 'M P12\n');
  assert.match(emptyId.notes[0], /empty wait ID/);
  const long = `${' '.repeat(2049)}M301P12\n`;
  assert.equal(recognized(long).source, long);
  assert.match(recognized(long).notes[0], /2,048/);
});

test('empty, unterminated and mixed line ending inputs preserve source structure', () => {
  for (const source of ['', '\n', 'G1X1', 'N1\r\nM30\r%']) assert.equal(recognized(source).source, source);
  assert.equal(clearWaitCodes(`M301P12 (${AUTO_WAIT_MARKER})`).source, '');
  assert.equal(recognized('G1X1\rM301P12\rG1Y2\nM302P12').source, 'G1X1\rG1Y2\n');
  assert.throws(() => clearWaitCodes(null), TypeError);
  assert.throws(() => clearWaitCodes('', {}, { scope: 'everything' }), RangeError);
});
