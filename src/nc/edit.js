/**
 * Edits on a parsed block list: rebuilding the text, moving blocks, and
 * dropping a block between two lines of another block.
 *
 * All functions are pure: they return a new list or new text and never change
 * their input. Positions are "insertion gaps": gap 0 is before the first
 * block, gap `blocks.length` is after the last one.
 */
import { splitRawLines, lineEnding, endsWithNewline } from './lines.js';

/** Join blocks back into program text. Exact inverse of parseProgram. */
export function serializeProgram(blocks) {
  return blocks.map((block) => block.text).join('');
}

/** Move one block to insertion gap `to`. */
export function moveBlock(blocks, from, to) {
  return moveRange(blocks, from, 1, to);
}

/**
 * Move `count` neighbouring blocks starting at `from` to insertion gap `to`.
 * Used to move a whole toolpath together with the waits inside it.
 */
export function moveRange(blocks, from, count, to) {
  if (!Number.isInteger(count) || count < 1) throw new RangeError('Move at least one block.');
  if (!Number.isInteger(from) || from < 0 || from + count > blocks.length) throw new RangeError('Source block index is out of range.');
  if (!Number.isInteger(to) || to < 0 || to > blocks.length) throw new RangeError('Insertion index is out of range.');
  if (to > from && to < from + count) throw new RangeError('A range cannot be moved inside itself.');

  const result = [...blocks];
  const moved = result.splice(from, count);
  // After removing the range, gaps beyond it shift down by `count`.
  result.splice(to > from ? to - count : to, 0, ...moved);
  return withLineBreaksBetween(result, blocks);
}

/**
 * Remove `blocks[from]` and insert its text before line `line` of
 * `blocks[target]`, e.g. to place a wait code in the middle of a toolpath.
 *
 * `line` is a gap strictly inside the target: 1 means "after its first line".
 * Returns the new program text; parse it again to regroup the blocks.
 */
export function moveIntoBlock(blocks, from, target, line) {
  if (!blocks[from] || !blocks[target] || from === target) throw new RangeError('Choose a different block to insert into.');
  const lines = splitRawLines(blocks[target].text);
  if (!Number.isInteger(line) || line < 1 || line >= lines.length) throw new RangeError('Insert between two lines of the block.');

  const eol = lineEnding(lines[0]);
  const moved = endsWithNewline(blocks[from].text) ? blocks[from].text : blocks[from].text + eol;
  const text = lines.slice(0, line).join('') + moved + lines.slice(line).join('');

  const updated = blocks.map((block, index) => (index === target ? { ...block, text } : block)).filter((_, index) => index !== from);
  return serializeProgram(updated);
}

/**
 * The last line of a program may have no line ending. If a move puts such a
 * block in the middle, add an ending so it does not merge with the next line.
 */
function withLineBreaksBetween(result, original) {
  const eol = original.map((block) => block.text.match(/\r\n|\n|\r/)?.[0]).find(Boolean) || '\n';
  for (let index = 0; index < result.length - 1; index += 1) {
    const current = result[index].text;
    if (current && !endsWithNewline(current) && !/^[\r\n]/.test(result[index + 1].text)) {
      result[index] = { ...result[index], text: current + eol };
    }
  }
  return result;
}
