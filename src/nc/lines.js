/**
 * Splitting NC text into lines and stripping comments.
 *
 * The editor must give back exactly the text it was given, byte for byte, so a
 * line keeps its original line ending (`raw`). The parser makes decisions on
 * `code`, the same line with comments blanked out.
 */

/**
 * @typedef {object} SourceLine
 * @property {string} raw      Line text including its own line ending (\r\n, \n, \r or none).
 * @property {string} content  Line text without the ending.
 * @property {number} line     1-based line number.
 * @property {string} [code]   `content` with comments replaced by spaces (added by `withCommentsBlanked`).
 */

/** Split text into lines, keeping each line's own ending so it can be rebuilt exactly. */
export function splitLines(source) {
  const lines = [];
  const oneLine = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  let match;
  while ((match = oneLine.exec(source)) && match[0]) {
    const raw = match[0];
    lines.push({ raw, content: raw.replace(/(?:\r\n|\r|\n)$/, ''), line: lines.length + 1 });
  }
  return lines;
}

/** Split text into raw lines (each still carrying its line ending). */
export function splitRawLines(text) {
  return text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g).filter(Boolean);
}

/**
 * Add `code` to each line: the content with comments blanked to spaces.
 *
 * Fanuc comments are `( ... )`, which may span lines, and `;` to the end of a
 * line. Blanking (instead of deleting) keeps character positions unchanged.
 */
export function withCommentsBlanked(lines) {
  let depth = 0; // how many "(" are open; carries over to the next line
  return lines.map((line) => {
    let code = '';
    for (const char of line.content) {
      if (char === ';' && depth === 0) break;
      if (char === '(') {
        depth += 1;
        code += ' ';
      } else if (char === ')' && depth > 0) {
        depth -= 1;
        code += ' ';
      } else {
        code += depth ? ' ' : char;
      }
    }
    return { ...line, code };
  });
}

/**
 * Comments removed, trimmed and upper-cased, one entry per line.
 * Used by the timing model, which only cares about executable words.
 */
export function executableLines(source) {
  let depth = 0;
  return String(source ?? '')
    .split(/\r\n|\r|\n/)
    .map((line) => {
      let result = '';
      for (const char of line) {
        if (char === '(') {
          depth += 1;
          continue;
        }
        if (char === ')' && depth) {
          depth -= 1;
          continue;
        }
        if (char === ';' && !depth) break;
        if (!depth) result += char;
      }
      return result.trim().toUpperCase();
    });
}

/** First `( comment )` text found in the given lines, trimmed. */
export function firstComment(lines) {
  return lines.map((line) => line.content.match(/\(([^()]*)\)/)?.[1]?.trim()).find(Boolean);
}

/** The first line ending used in `text`, or `fallback` when it has none. */
export function lineEnding(text, fallback = '\n') {
  return text.match(/\r\n|\n|\r/)?.[0] || fallback;
}

/** True when `text` ends with a line ending. */
export function endsWithNewline(text) {
  return /[\r\n]$/.test(text);
}
