import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WAIT_PATTERN, parseProgram, serializeProgram, moveBlock, validateWaitPattern } from '../src/parser.js';

test('default matches the machine M3XXPXX wait form', () => {
  assert.equal(DEFAULT_WAIT_PATTERN, '\\bM(3\\d{2})\\s*P(\\d+)\\b');
  const { blocks } = parseProgram('M301P12\nM302 P34');
  assert.deepEqual(blocks.map((block) => block.sync.key), ['301P12', '302P34']);
  assert.equal(blocks[0].sync.participants, '12');
  assert.equal(blocks[0].sync.code, 'M301P12');
  assert.equal(parseProgram('M301P12', { waitParticipantMode: 'ignore' }).blocks[0].sync.key, '301');
});

test('parsing and serialization preserve mixed EOLs, comments, spacing and the final newline exactly', () => {
  const source = '%\r\nO1000 (HORIZONTAL)\r\n\r\n(T1)\r\nT1 M06\nG0 B90\rN100 (END T1)\r\nM301P12 ; WAIT\n#501=123\r\nWHILE[#502NE124]DO1\r\n(COMMENT)\nEND1\r\nM30\r\n%';
  const parsed = parseProgram(source);
  assert.equal(serializeProgram(parsed.blocks), source);
  assert.equal(parsed.eol, '\r\n');
  assert.equal(parsed.trailingNewline, false);
  assert.equal(parsed.blocks.find((block) => block.kind === 'toolpath').terminalN, 'N100');
  assert.equal(new Set(parsed.blocks.map((block) => block.id)).size, parsed.blocks.length);
});

test('a toolpath ends at the N line and the next path begins after it', () => {
  const source = '(DRILL)\nT1 M6\nG1 X1\nN100\n(MILL)\nG1 Y2\nN200\n';
  const { blocks } = parseProgram(source);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((block) => [block.kind, block.startLine, block.endLine, block.terminalN]), [
    ['toolpath', 1, 4, 'N100'], ['toolpath', 5, 7, 'N200'],
  ]);
  assert.equal(blocks[0].text, '(DRILL)\nT1 M6\nG1 X1\nN100\n');
});

test('explicit program header and end markers are separate from movable toolpaths', () => {
  const parsed = parseProgram('%\nO12\n(T1)\nG1X1\nN1\nM30\n%\n');
  assert.deepEqual(parsed.blocks.map((block) => block.kind), ['code', 'code', 'toolpath', 'code', 'code']);
  assert.deepEqual(parsed.blocks.map((block) => block.title).filter((title) => title === 'Program end'), ['Program end', 'Program end']);
  assert.equal(parsed.blocks[2].text, '(T1)\nG1X1\nN1\n');
});

test('configured legacy M pattern is honored and waits split ordinary code', () => {
  const parsed = parseProgram('G0 X0\nM201\nG1 X1\nN1\n', { waitPattern: '\\bM(2\\d{2})\\b' });
  assert.deepEqual(parsed.blocks.map((block) => block.kind), ['code', 'wait', 'toolpath']);
  assert.equal(parsed.blocks[1].sync.key, '201');
  assert.equal(serializeProgram(parsed.blocks), 'G0 X0\nM201\nG1 X1\nN1\n');
});

test('comments never create waits, N boundaries, signals or motion flags', () => {
  const source = '(M301P12 B90 M06 G68 N1)\n; M302P12\n(OPEN\nM303P12\nCLOSE)\nG1X1\nN2\n';
  const parsed = parseProgram(source);
  assert.equal(parsed.blocks.length, 1);
  assert.equal(parsed.blocks[0].kind, 'toolpath');
  assert.deepEqual(parsed.blocks[0].flags, { rotation: false, toolChange: false, g68: false });
  assert.equal(serializeProgram(parsed.blocks), source);
});

test('B axis motion, M6 and G68 are flagged independent of letter case and spacing', () => {
  const block = parseProgram('g0b[#500]\nm 06\ng68 x0 y0 r90\nN10').blocks[0];
  assert.deepEqual(block.flags, { rotation: true, toolChange: true, g68: true });
});

test('empty macro spin waits and numeric signals share normalized sync identities', () => {
  const source = '#0501=+00123.00 (READY)\r\nWHILE [ #501 NE 123 ] DO1\r\n; idle\r\nEND1';
  const parsed = parseProgram(source, {}, 'v');
  assert.deepEqual(parsed.blocks.map((block) => block.kind), ['signal', 'macro-wait']);
  assert.deepEqual(parsed.blocks.map((block) => block.sync.key), ['#501=123', '#501=123']);
  assert.equal(parsed.blocks[0].sync.variable, '501');
  assert.equal(parsed.blocks[1].sync.role, 'wait');
  assert.equal(parsed.blocks[1].startLine, 2);
  assert.equal(parsed.blocks[1].endLine, 4);
  assert.ok(parsed.blocks[1].id.startsWith('v-'));
  assert.equal(serializeProgram(parsed.blocks), source);
});

test('negative and decimal macro constants normalize without floating-point loss', () => {
  const parsed = parseProgram('#501=-000.500\nWHILE[#501NE-.50]DO2\nEND2\n#502=-0\n');
  assert.deepEqual(parsed.blocks.map((block) => block.sync.key), ['#501=-0.5', '#501=-0.5', '#502=0']);
});

test('a macro loop with executable body remains atomic and its nested waits are never extracted', () => {
  const source = 'G0X0\nWHILE[#100LT3]DO1\nM301P12\n#501=123\nG1X1\nN100\nEND1\nM302P12\n';
  const parsed = parseProgram(source);
  assert.deepEqual(parsed.blocks.map((block) => block.kind), ['code', 'code', 'wait']);
  assert.equal(parsed.blocks[1].text, 'WHILE[#100LT3]DO1\nM301P12\n#501=123\nG1X1\nN100\nEND1\n');
  assert.equal(parsed.diagnostics[0].code, 'unsupported-loop');
  assert.equal(serializeProgram(parsed.blocks), source);
});

test('nested loops stay together even if the inner loop looks like a sync wait', () => {
  const source = 'WHILE[#100LT3]DO1\nWHILE[#501NE123]DO2\nEND2\nM301P12\nEND1\n';
  const parsed = parseProgram(source);
  assert.equal(parsed.blocks.length, 1);
  assert.equal(parsed.blocks[0].kind, 'code');
  assert.equal(parsed.diagnostics[0].code, 'unsupported-loop');
  assert.equal(serializeProgram(parsed.blocks), source);
});

test('unclosed and mismatched loops produce diagnostics and keep source intact', () => {
  for (const source of ['WHILE[#501NE1]DO1\nM301P12\n', 'WHILE[#501NE1]DO1\nEND2\n']) {
    const parsed = parseProgram(source);
    assert.equal(parsed.blocks.length, 1);
    assert.equal(parsed.blocks[0].kind, 'code');
    assert.ok(['unclosed-loop', 'mismatched-loop'].includes(parsed.diagnostics[0].code));
    assert.equal(serializeProgram(parsed.blocks), source);
  }
});

test('unrecognized WHILE forms retain remaining source instead of extracting unsafe inner waits', () => {
  const source = 'WHILE[#501NE1]\nM301P12\nEND1\n';
  const parsed = parseProgram(source);
  assert.equal(parsed.blocks.length, 1);
  assert.equal(parsed.blocks[0].kind, 'code');
  assert.equal(parsed.diagnostics[0].code, 'unsupported-loop');
  assert.equal(serializeProgram(parsed.blocks), source);
});

test('waits sharing executable lines retain the entire line and warn', () => {
  const source = 'M301P12 G0 B90\n';
  const parsed = parseProgram(source);
  assert.equal(parsed.blocks[0].kind, 'wait');
  assert.equal(parsed.blocks[0].text, source);
  assert.equal(parsed.blocks[0].flags.rotation, true);
  assert.equal(parsed.diagnostics[0].code, 'combined-wait-line');
});

test('multiple wait codes on one line stay ordinary atomic code and warn', () => {
  const source = 'M301P12 M302P12\n';
  const parsed = parseProgram(source);
  assert.equal(parsed.blocks[0].kind, 'code');
  assert.equal(parsed.blocks[0].sync, null);
  assert.equal(parsed.diagnostics[0].code, 'multiple-waits');
  assert.equal(serializeProgram(parsed.blocks), source);
});

test('repeated wait identities remain separate blocks for the alignment engine to diagnose', () => {
  const parsed = parseProgram('M301P12\nM301P12\n');
  assert.equal(parsed.blocks.length, 2);
  assert.equal(parsed.blocks[0].sync.key, parsed.blocks[1].sync.key);
  assert.notEqual(parsed.blocks[0].id, parsed.blocks[1].id);
});

test('invalid and unsafe patterns fail closed with a useful diagnostic', () => {
  for (const pattern of ['(', 'M300', '(a+)+', '(?=M)(300)', '.*(M300)', '(M300)\\1']) {
    assert.equal(validateWaitPattern(pattern).valid, false, pattern);
    const parsed = parseProgram('M301P12\n', { waitPattern: pattern });
    assert.equal(parsed.diagnostics[0].code, 'invalid-wait-pattern', pattern);
    assert.equal(parsed.blocks[0].kind, 'code', pattern);
    assert.equal(serializeProgram(parsed.blocks), 'M301P12\n');
  }
});

test('empty, no-newline, and lone-EOL programs roundtrip', () => {
  for (const source of ['', '\n', '\r\n', 'G0X1', 'N1', '%\rO1\rN2\r']) {
    const parsed = parseProgram(source);
    assert.equal(serializeProgram(parsed.blocks), source);
    assert.equal(parsed.trailingNewline, /[\r\n]$/.test(source));
  }
});

test('moving a final unterminated block into the middle never merges NC lines', () => {
  const parsed = parseProgram('G1X1\r\nN1\r\nG1X2\r\nN2');
  const snapshot = parsed.blocks.map((block) => ({ ...block }));
  const moved = moveBlock(parsed.blocks, 1, 0);
  assert.equal(serializeProgram(moved), 'G1X2\r\nN2\r\nG1X1\r\nN1\r\n');
  assert.deepEqual(parsed.blocks, snapshot);
  assert.equal(moved[0].id, parsed.blocks[1].id);
});

test('moving uses original insertion gaps and validates indexes', () => {
  const blocks = parseProgram('N1\nN2\nN3\n').blocks;
  assert.deepEqual(moveBlock(blocks, 0, 3).map((block) => block.terminalN), ['N2', 'N3', 'N1']);
  assert.deepEqual(moveBlock(blocks, 0, 1), blocks);
  assert.deepEqual(moveBlock(blocks, 1, 1), blocks);
  assert.throws(() => moveBlock(blocks, -1, 0), RangeError);
  assert.throws(() => moveBlock(blocks, 0, 4), RangeError);
});
