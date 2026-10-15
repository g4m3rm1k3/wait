/**
 * The user-configurable wait-code pattern.
 *
 * A paired wait looks like `M301P12` on this machine: M3xx is the wait ID and
 * P lists the channels that take part. Other controls use other syntax, so the
 * pattern is a regex the user can change in Settings:
 *   - capture group 1 = wait ID      (required)
 *   - capture group 2 = P / channels (optional)
 */

export const DEFAULT_WAIT_PATTERN = '\\bM(3\\d{2})\\s*P(\\d+)\\b';

const MAX_PATTERN_LENGTH = 256;
const MAX_VARIABLE_REPEATS = 2;

/**
 * Check a user-entered wait pattern before using it.
 *
 * Only a small, predictable subset of regex is allowed. Group repetition,
 * backreferences, lookarounds and repeated wildcards can make a regex take
 * exponential time and freeze the editor; ordinary M/P patterns need none.
 *
 * @returns {{valid: true, regex: RegExp} | {valid: false, error: string}}
 */
export function validateWaitPattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) {
    return invalid('Enter a wait-code pattern with a capture group for the wait ID.');
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return invalid(`Wait-code patterns must be ${MAX_PATTERN_LENGTH} characters or fewer.`);
  }

  const scan = scanPattern(pattern);
  if (scan.error) return invalid(scan.error);
  if (scan.variableRepeats > MAX_VARIABLE_REPEATS) {
    return invalid('Use at most two variable-length repeats; fixed counts such as {2} are supported.');
  }
  if (!scan.captures) {
    return invalid('The first capture group must contain the wait ID, for example M(3[0-9]{2})P([0-9]{2}).');
  }

  try {
    const regex = new RegExp(pattern, 'gi');
    if (new RegExp(pattern, 'i').test('')) return invalid('The wait-code pattern must not match empty text.');
    return { valid: true, regex };
  } catch (error) {
    return invalid(`Invalid wait-code pattern: ${error.message}`);
  }
}

function invalid(error) {
  return { valid: false, error };
}

/**
 * Walk the pattern once, character by character, counting capture groups and
 * unbounded repeats and rejecting unsupported constructs.
 */
function scanPattern(pattern) {
  let insideClass = false; // inside [...]
  let escaped = false; // previous character was a backslash
  let captures = 0;
  let variableRepeats = 0;

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1] || '';

    if (escaped) {
      escaped = false;
      if (!insideClass && /[1-9]/.test(char)) return { error: 'Backreferences are not supported in wait-code patterns.' };
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '[' && !insideClass) {
      insideClass = true;
      continue;
    }
    if (char === ']' && insideClass) {
      insideClass = false;
      continue;
    }
    if (insideClass) continue;

    if (char === '(') {
      const special = next === '?';
      if (special && pattern.slice(i, i + 3) !== '(?:') {
        return { error: 'Lookarounds and special capture groups are not supported.' };
      }
      if (!special) captures += 1;
    }
    if (char === ')' && /^[*+?{]/.test(next)) {
      return { error: 'Repeating a group is not supported; repeat the code characters inside the group.' };
    }
    if (char === '.' && /^[*+{]/.test(next)) {
      return { error: 'Repeated wildcards are not supported; use a character class such as [0-9].' };
    }
    if (char === '*' || char === '+' || (char === '{' && /^\{\d+,\}/.test(pattern.slice(i)))) {
      variableRepeats += 1;
    }
  }
  return { captures, variableRepeats };
}
