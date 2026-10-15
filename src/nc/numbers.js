/**
 * Number handling shared by the parser, the alignment and the timing model.
 *
 * NC programs write the same value many ways: "90", "90.", "090.000", "+90".
 * Wait codes and macro values must match regardless of spelling, so every
 * comparison goes through `canonicalNumber`.
 */

/** Regex source for one NC numeric literal: 12, -3, 4.5, .5, 7. (no exponent). */
export const NUMBER_PATTERN = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';

const WHOLE_NUMBER = new RegExp(`^${NUMBER_PATTERN}$`);

/** True when `text` is exactly one NC numeric literal. */
export function isNumberLiteral(text) {
  return WHOLE_NUMBER.test(text);
}

/**
 * Canonical spelling of a numeric literal, used as a matching key.
 *
 *   canonicalNumber('090.500') -> '90.5'
 *   canonicalNumber('+20.')    -> '20'
 *   canonicalNumber('-0.0')    -> '0'
 *
 * The input must already be a valid literal (see `isNumberLiteral`).
 * Text is compared, never converted to a float, so no rounding can make two
 * different source values look equal.
 */
export function canonicalNumber(value) {
  const negative = value.startsWith('-');
  const unsigned = value.replace(/^[+-]/, '');
  let [whole = '0', fraction = ''] = unsigned.split('.');

  whole = whole.replace(/^0+(?=\d)/, '') || '0'; // drop leading zeros, keep one digit
  fraction = fraction.replace(/0+$/, ''); // drop trailing zeros

  const result = fraction ? `${whole}.${fraction}` : whole;
  return negative && result !== '0' ? `-${result}` : result;
}
