/** Remove paired wait codes without rewriting the surrounding NC source. */
import { splitLines, withCommentsBlanked } from '../nc/lines.js';
import { parseProgram } from '../nc/parser.js';
import { DEFAULT_WAIT_PATTERN, validateWaitPattern } from '../nc/wait-pattern.js';

export const AUTO_WAIT_MARKER = 'SPINDLE SYNC AUTO';
const OWN_COMMENT = /^\(SPINDLE SYNC AUTO(?:\s[^()]*)?\)$/i;
const ASSIGNMENT = /#\s*(?:\d+|\[[^\]]*\]|<[^>]*>)\s*=/i;
const CONTROL_FLOW = /\b(?:IF|GOTO|DO|END)(?=\b|\d)/i;
const MAX_WAIT_SCAN_LENGTH = 2048;

/**
 * `generated` removes only standalone waits carrying this editor's ownership
 * comment. `recognized` removes configured barrier matches, including ones
 * sharing a line with motion. Macro assignments, control-flow lines and
 * complete WHILE blocks are outside both scopes. `removed` counts wait codes
 * rather than source lines.
 */
export function clearWaitCodes(source, settings = {}, { scope = 'generated' } = {}) {
  if (typeof source !== 'string') throw new TypeError('Program source must be a string.');
  if (!['generated', 'recognized'].includes(scope)) throw new RangeError('Choose generated or recognized wait codes.');
  const pattern = validateWaitPattern(settings.waitPattern ?? DEFAULT_WAIT_PATTERN);
  if (!pattern.valid) return { source, removed: 0, notes: [`Wait codes were kept: ${pattern.error}`] };

  const lines = withCommentsBlanked(splitLines(source));
  const comments = commentDetails(lines);
  const protectedLines = new Set();
  let loopCount = 0;
  for (const block of parseProgram(source, settings).blocks) {
    const blockLines = lines.slice(block.startLine - 1, block.endLine);
    if (!blockLines.some((line) => /\bWHILE\b/i.test(line.code))) continue;
    loopCount += 1;
    for (let line = block.startLine; line <= block.endLine; line += 1) protectedLines.add(line);
  }

  let removed = 0;
  let assignmentCount = 0;
  let controlFlowCount = 0;
  let longLines = 0;
  let emptyIds = 0;
  const output = lines.map((line, index) => {
    const assignment = ASSIGNMENT.test(line.code);
    if (assignment) assignmentCount += 1;
    if (assignment || protectedLines.has(line.line)) return line.raw;
    // Removing a conditional wait can leave an IF without an executable body.
    if (CONTROL_FLOW.test(line.code)) {
      controlFlowCount += 1;
      return line.raw;
    }
    if (line.code.length > MAX_WAIT_SCAN_LENGTH) {
      longLines += 1;
      return line.raw;
    }

    pattern.regex.lastIndex = 0;
    const matches = [...line.code.matchAll(pattern.regex)].filter((match) => {
      if (match[0] && match[1]) return true;
      emptyIds += 1;
      return false;
    });
    if (!matches.length) return line.raw;

    const details = comments[index];
    const remainingCode = removeRanges(line.code, matches).trim();
    const wholeLine = !remainingCode && !details.multiline;
    if (scope === 'generated') {
      if (!wholeLine || !details.owned) return line.raw;
    }

    removed += matches.length;
    // Retain user comments, including both ends of multiline comments. A line
    // wholly owned by this editor, or containing only a wait, can disappear.
    if (wholeLine && (!details.hasComment || details.onlyOwned)) return '';
    const removeAt = new Set();
    for (const match of matches) {
      for (let offset = match.index; offset < match.index + match[0].length; offset += 1) {
        if (!details.commentAt.has(offset)) removeAt.add(offset);
      }
    }
    if (scope === 'generated') {
      for (const comment of details.ownedComments) {
        for (let offset = comment.start; offset < comment.end; offset += 1) removeAt.add(offset);
      }
    }
    return line.content.split('').filter((_, offset) => !removeAt.has(offset)).join('') + line.raw.slice(line.content.length);
  });

  const notes = [];
  if (assignmentCount || loopCount) {
    notes.push(`Kept ${assignmentCount} macro assignment line(s) and ${loopCount} WHILE block(s) unchanged; clearing waits only removes paired wait codes.`);
  }
  if (controlFlowCount) notes.push(`Kept ${controlFlowCount} control-flow line(s) unchanged; removing a conditional wait could leave invalid NC code.`);
  if (longLines) notes.push(`Kept ${longLines} line(s) longer than 2,048 characters without scanning for wait codes.`);
  if (emptyIds) notes.push(`Kept ${emptyIds} pattern match(es) with an empty wait ID.`);
  return { source: output.join(''), removed, notes };
}

function removeRanges(text, matches) {
  let result = '';
  let start = 0;
  for (const match of matches) {
    result += text.slice(start, match.index);
    start = match.index + match[0].length;
  }
  return result + text.slice(start);
}

/** Locate actual comments; a marker quoted inside another comment is not ownership. */
function commentDetails(lines) {
  let depth = 0;
  return lines.map((line) => {
    const commentAt = new Set();
    const complete = [];
    const startsInside = depth > 0;
    let opening = startsInside ? null : -1;
    let semicolon = false;
    for (let offset = 0; offset < line.content.length; offset += 1) {
      const char = line.content[offset];
      if (char === ';' && depth === 0) {
        semicolon = true;
        for (let rest = offset; rest < line.content.length; rest += 1) commentAt.add(rest);
        break;
      }
      if (char === '(') {
        if (depth === 0) opening = offset;
        depth += 1;
        commentAt.add(offset);
      } else if (depth > 0) {
        commentAt.add(offset);
        if (char === ')') {
          depth -= 1;
          if (depth === 0 && opening !== null && opening >= 0) {
            complete.push({ text: line.content.slice(opening, offset + 1), start: opening, end: offset + 1 });
          }
        }
      }
    }
    const multiline = startsInside || depth > 0;
    const ownedComments = complete.filter((comment) => OWN_COMMENT.test(comment.text));
    const owned = ownedComments.length > 0;
    return {
      commentAt,
      hasComment: commentAt.size > 0,
      owned,
      ownedComments,
      onlyOwned: !multiline && !semicolon && complete.length > 0 && complete.every((comment) => OWN_COMMENT.test(comment.text)),
      multiline,
    };
  });
}
