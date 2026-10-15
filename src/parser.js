/** Lossless, deliberately conservative NC block parsing for the two-channel editor. */
export const DEFAULT_WAIT_PATTERN = '\\bM(3\\d{2})\\s*P(\\d+)\\b';

const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const MACRO_WAIT = new RegExp(`^\\s*WHILE\\s*\\[\\s*#(\\d+)\\s*NE\\s*(${NUMBER})\\s*\\]\\s*DO\\s*(\\d+)\\s*$`, 'i');
const SIGNAL = new RegExp(`^\\s*#(\\d+)\\s*=\\s*(${NUMBER})\\s*$`, 'i');
const LOOP_OPEN = /\bWHILE\s*\[.*\]\s*DO\s*(\d+)\b/i;
const LOOP_END = /\bEND\s*(\d+)\b/i;
const EMPTY_FLAGS = () => ({ rotation: false, toolChange: false, g68: false });

/**
 * The pattern is intentionally restricted to a small, predictable regex subset.
 * Group repetition, backreferences, lookarounds, and repeated wildcards can make
 * a user-entered expression freeze an editor; ordinary M/P patterns need none.
 */
export function validateWaitPattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) {
    return { valid: false, error: 'Enter a wait-code pattern with a capture group for the wait ID.' };
  }
  if (pattern.length > 256) {
    return { valid: false, error: 'Wait-code patterns must be 256 characters or fewer.' };
  }
  let inClass = false;
  let escaped = false;
  let captures = 0;
  let unbounded = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (escaped) {
      if (!inClass && /[1-9]/.test(char)) {
        return { valid: false, error: 'Backreferences are not supported in wait-code patterns.' };
      }
      escaped = false;
      continue;
    }
    if (char === '\\') { escaped = true; continue; }
    if (char === '[' && !inClass) { inClass = true; continue; }
    if (char === ']' && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (char === '(') {
      if (pattern[i + 1] === '?' && pattern.slice(i, i + 3) !== '(?:') {
        return { valid: false, error: 'Lookarounds and special capture groups are not supported.' };
      }
      if (pattern[i + 1] !== '?') captures += 1;
    }
    if (char === ')' && /^[*+?{]/.test(pattern[i + 1] || '')) {
      return { valid: false, error: 'Repeating a group is not supported; repeat the code characters inside the group.' };
    }
    if (char === '.' && /^[*+{]/.test(pattern[i + 1] || '')) {
      return { valid: false, error: 'Repeated wildcards are not supported; use a character class such as [0-9].' };
    }
    if (char === '*' || char === '+' || (char === '{' && /^\{\d+,\}/.test(pattern.slice(i)))) unbounded += 1;
  }
  if (unbounded > 2) {
    return { valid: false, error: 'Use at most two variable-length repeats; fixed counts such as {2} are supported.' };
  }
  if (!captures) return { valid: false, error: 'The first capture group must contain the wait ID, for example M(3[0-9]{2})P([0-9]{2}).' };
  try {
    const regex = new RegExp(pattern, 'gi');
    if (new RegExp(pattern, 'i').test('')) {
      return { valid: false, error: 'The wait-code pattern must not match empty text.' };
    }
    return { valid: true, regex };
  } catch (error) {
    return { valid: false, error: `Invalid wait-code pattern: ${error.message}` };
  }
}

function splitLines(source) {
  const lines = [];
  const expression = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  let match;
  while ((match = expression.exec(source)) && match[0]) {
    const raw = match[0];
    lines.push({ raw, content: raw.replace(/(?:\r\n|\r|\n)$/, ''), line: lines.length + 1 });
  }
  return lines;
}

function removeComments(lines) {
  let depth = 0;
  return lines.map((line) => {
    let code = '';
    for (const char of line.content) {
      if (char === ';' && depth === 0) break;
      if (char === '(') { depth += 1; code += ' '; }
      else if (char === ')' && depth > 0) { depth -= 1; code += ' '; }
      else code += depth ? ' ' : char;
    }
    return { ...line, code };
  });
}

export function analyzeFlags(code) {
  return {
    rotation: /B\s*[+-]?(?:\d|\.|#|\[)/i.test(code),
    toolChange: /M\s*0*6(?![\d.])/i.test(code),
    g68: /G\s*0*68(?:\.\d+)?(?![\d.])/i.test(code),
  };
}

function canonicalNumber(value) {
  const negative = value.startsWith('-');
  let unsigned = value.replace(/^[+-]/, '');
  let [whole = '0', fraction = ''] = unsigned.split('.');
  whole = whole.replace(/^0+(?=\d)/, '') || '0';
  fraction = fraction.replace(/0+$/, '');
  const result = fraction ? `${whole}.${fraction}` : whole;
  return negative && result !== '0' ? `-${result}` : result;
}

function macroSync(variable, value, role) {
  variable = canonicalNumber(variable);
  value = canonicalNumber(value);
  return { kind: 'macro', key: `#${variable}=${value}`, role, variable, value };
}

function findLoopEnd(lines, start) {
  const stack = [];
  let mismatch = false;
  for (let index = start; index < lines.length; index += 1) {
    const opening = lines[index].code.match(LOOP_OPEN);
    if (opening) stack.push(opening[1]);
    const closing = lines[index].code.match(LOOP_END);
    if (closing) {
      if (stack[stack.length - 1] !== closing[1]) mismatch = true;
      if (stack.length) stack.pop();
      else return { end: index, mismatch: true, closed: false };
      if (!stack.length) return { end: index, mismatch, closed: true };
    }
  }
  return { end: lines.length - 1, mismatch, closed: false };
}

function titleFor(lines, kind, sync, terminalN) {
  if (kind === 'wait') return `Wait ${sync.code.trim()}`;
  if (kind === 'macro-wait') return `Wait for #${sync.variable} = ${sync.value}`;
  if (kind === 'signal') return `Set #${sync.variable} = ${sync.value}`;
  const comment = lines.map((line) => line.content.match(/\(([^()]*)\)/)?.[1]?.trim()).find(Boolean);
  if (kind === 'toolpath') return comment ? `${comment} · ${terminalN}` : `Toolpath ending ${terminalN}`;
  return comment || lines.find((line) => line.code.trim())?.code.trim().slice(0, 70) || 'Comments / spacing';
}

/** Parse into exact source slices. Unknown or complex constructs stay intact. */
export function parseProgram(source, options = {}, channel = 'h') {
  if (typeof source !== 'string') throw new TypeError('Program source must be a string.');
  const lines = removeComments(splitLines(source));
  const diagnostics = [];
  const blocks = [];
  const eol = source.match(/\r\n|\n|\r/)?.[0] || '\n';
  const trailingNewline = /[\r\n]$/.test(source);
  const validation = validateWaitPattern(options.waitPattern ?? DEFAULT_WAIT_PATTERN);
  const waitRegex = validation.valid ? validation.regex : null;
  if (!validation.valid) diagnostics.push({ severity: 'error', code: 'invalid-wait-pattern', message: validation.error, line: 1 });
  let pending = [];

  function add(segment, kind = 'code', sync = null, terminalN, title) {
    if (!segment.length) return;
    const text = segment.map((line) => line.raw).join('');
    const code = segment.map((line) => line.code).join('\n');
    const block = {
      id: `${channel}-${segment[0].line}-${blocks.length}`,
      kind, text, startLine: segment[0].line, endLine: segment[segment.length - 1].line,
      title: title || titleFor(segment, kind, sync, terminalN), sync,
      flags: code ? analyzeFlags(code) : EMPTY_FLAGS(),
    };
    if (terminalN) block.terminalN = terminalN;
    const comment = segment.map((line) => line.content.match(/\(([^()]*)\)/)?.[1]?.trim()).find(Boolean);
    if (comment) block.comment = comment;
    blocks.push(block);
  }
  function flush(kind = 'code', terminalN, title) {
    add(pending, kind, null, terminalN, title);
    pending = [];
  }
  function warn(code, message, line, severity = 'warning') { diagnostics.push({ severity, code, message, line }); }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const code = line.code;
    const opening = code.match(LOOP_OPEN);
    if (opening) {
      flush();
      const range = findLoopEnd(lines, index);
      const segment = lines.slice(index, range.end + 1);
      const exact = code.match(MACRO_WAIT);
      const pureEnd = new RegExp(`^\\s*END\\s*${opening[1]}\\s*$`, 'i').test(segment[segment.length - 1].code);
      const emptyBody = segment.slice(1, -1).every((entry) => !entry.code.trim());
      if (range.closed && !range.mismatch && segment.length >= 2 && exact && pureEnd && emptyBody) {
        add(segment, 'macro-wait', macroSync(exact[1], exact[2], 'wait'));
      } else {
        add(segment, 'code', null, undefined, 'Macro loop (kept together)');
        const reason = !range.closed ? 'This WHILE loop has no matching END; its remaining source was kept together.'
          : range.mismatch ? 'WHILE / END numbers do not match; this loop was kept together.'
            : !emptyBody ? 'This WHILE loop contains executable code. Its body and synchronization stay together.'
              : 'Only empty WHILE [#variable NE numeric-value] DO / END loops are recognized as movable waits.';
        warn(!range.closed ? 'unclosed-loop' : range.mismatch ? 'mismatched-loop' : 'unsupported-loop', reason, line.line);
      }
      index = range.end;
      continue;
    }
    if (/\bWHILE\b/i.test(code)) {
      flush();
      add(lines.slice(index), 'code', null, undefined, 'Unrecognized macro loop (kept together)');
      warn('unsupported-loop', 'This WHILE form is not recognized. Its remaining source was kept together to avoid splitting a loop.', line.line);
      break;
    }
    if (LOOP_END.test(code)) warn('unmatched-loop-end', 'END has no recognized WHILE before it.', line.line);

    const signal = code.match(SIGNAL);
    if (signal) {
      flush();
      add([line], 'signal', macroSync(signal[1], signal[2], 'signal'));
      continue;
    }

    let waits = [];
    if (waitRegex && code.length <= 2048) {
      waitRegex.lastIndex = 0;
      waits = [...code.matchAll(waitRegex)];
    } else if (waitRegex && code.length > 2048) {
      warn('long-line', 'Wait matching was skipped on a line longer than 2,048 characters.', line.line);
    }
    if (waits.length) {
      const match = waits[0];
      if (!match[1]) {
        warn('empty-wait-id', 'A wait-code match had an empty first capture and was kept as ordinary code.', line.line);
      } else if (waits.length > 1) {
        flush();
        add([line], 'code', null, undefined, 'Multiple waits on one line (kept together)');
        warn('multiple-waits', 'This line contains multiple wait codes and cannot represent one alignment point. Put each wait on its own line.', line.line);
        continue;
      } else {
        flush();
        const participants = match[2] || undefined;
        const key = options.waitParticipantMode !== 'ignore' && participants ? `${match[1]}P${participants}` : match[1];
        add([line], 'wait', { kind: 'barrier', key, role: 'barrier', ...(participants ? { participants } : {}), code: match[0] });
        const remainder = `${code.slice(0, match.index)}${code.slice(match.index + match[0].length)}`.trim();
        if (remainder) warn('combined-wait-line', 'This wait shares a line with other executable code; dragging moves the entire line.', line.line);
        continue;
      }
    }

    const programNumber = /^\s*O\s*\d+\s*$/i.test(code);
    const percent = /^\s*%\s*$/.test(code);
    const programEnd = /^\s*M\s*0*(?:2|30)\s*$/i.test(code);
    if (programNumber || percent || programEnd) {
      if (pending.length && pending.every((entry) => !entry.code.trim())) flush('code', undefined, blocks.length ? 'Comments / spacing' : 'Program header');
      else flush();
      const footer = programEnd || (percent && blocks.some((block) => block.kind === 'toolpath'));
      add([line], 'code', null, undefined, footer ? 'Program end' : 'Program header');
      continue;
    }

    pending.push(line);
    const terminal = code.match(/^\s*N\s*(\d+)\b/i);
    if (terminal) flush('toolpath', `N${terminal[1]}`);
  }
  flush();
  assignToolpaths(blocks);
  return { blocks, diagnostics, eol, trailingNewline };
}

const BOUNDARY_TITLES = new Set(['Program header', 'Program end']);
const KEEP_TITLES = new Set(['Comments / spacing', 'Macro loop (kept together)', 'Unrecognized macro loop (kept together)', 'Multiple waits on one line (kept together)']);

/**
 * A toolpath is every block up to and including its ending N line, so waits and
 * B indexes placed mid-path stay part of it. Each member gets
 * `toolpath = { n, label, part, parts }`; members are always contiguous.
 */
function assignToolpaths(blocks) {
  let members = [];
  for (const block of blocks) {
    if (BOUNDARY_TITLES.has(block.title)) { members = []; continue; }
    members.push(block);
    if (block.kind !== 'toolpath') continue;
    const comment = members.find((member) => !member.sync && member.comment)?.comment;
    const label = comment ? `${comment} · ${block.terminalN}` : `Toolpath ${block.terminalN}`;
    members.forEach((member, index) => {
      member.toolpath = { n: block.terminalN, label, part: index + 1, parts: members.length };
      if (members.length < 2 || member.sync || KEEP_TITLES.has(member.title)) return;
      const code = member.text.replace(/\([^)]*\)|;[^\r\n]*/g, '');
      const bTarget = [...code.matchAll(/\bB\s*([+-]?[\d.]+)/gi)].at(-1)?.[1];
      const cuts = /\bG\s*0*[123](?![\d.])/i.test(code) || /\bM\s*0*6(?![\d.])/i.test(code);
      if (member.flags.rotation && !cuts && !member.comment) member.title = `B index${bTarget ? ` → B${bTarget}` : ''} · ${block.terminalN}`;
      else if (!member.comment || member === block) member.title = label;
    });
    members = [];
  }
}

export function serializeProgram(blocks) { return blocks.map((block) => block.text).join(''); }

/** `to` is an insertion gap in the original array, from 0 through length. */
export function moveBlock(blocks, from, to) { return moveRange(blocks, from, 1, to); }

/** Move `count` contiguous blocks starting at `from` to insertion gap `to`. */
export function moveRange(blocks, from, count, to) {
  if (!Number.isInteger(count) || count < 1) throw new RangeError('Move at least one block.');
  if (!Number.isInteger(from) || from < 0 || from + count > blocks.length) throw new RangeError('Source block index is out of range.');
  if (!Number.isInteger(to) || to < 0 || to > blocks.length) throw new RangeError('Insertion index is out of range.');
  if (to > from && to < from + count) throw new RangeError('A range cannot be moved inside itself.');
  const result = [...blocks];
  const moved = result.splice(from, count);
  result.splice(to > from ? to - count : to, 0, ...moved);
  const eol = blocks.map((entry) => entry.text.match(/\r\n|\n|\r/)?.[0]).find(Boolean) || '\n';
  for (let index = 0; index < result.length - 1; index += 1) {
    if (result[index].text && !/[\r\n]$/.test(result[index].text) && !/^[\r\n]/.test(result[index + 1].text)) {
      result[index] = { ...result[index], text: result[index].text + eol };
    }
  }
  return result;
}

/**
 * Remove blocks[from] and insert its text before line `line` (1-based gap, strictly
 * inside) of blocks[target]. Returns the new program text; reparse to regroup.
 */
export function moveIntoBlock(blocks, from, target, line) {
  if (!blocks[from] || !blocks[target] || from === target) throw new RangeError('Choose a different block to insert into.');
  const lines = blocks[target].text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g).filter(Boolean);
  if (!Number.isInteger(line) || line < 1 || line >= lines.length) throw new RangeError('Insert between two lines of the block.');
  const eol = lines[0].match(/\r\n|\n|\r/)?.[0] || '\n';
  const moved = /[\r\n]$/.test(blocks[from].text) ? blocks[from].text : blocks[from].text + eol;
  const text = lines.slice(0, line).join('') + moved + lines.slice(line).join('');
  return serializeProgram(blocks.map((block, index) => (index === target ? { ...block, text } : block)).filter((_, index) => index !== from));
}
