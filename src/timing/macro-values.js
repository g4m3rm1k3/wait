/**
 * Macro variable values for the timing model.
 *
 * The scheduler stores real numbers for shared variables (#501 = 20), so a wait
 * can compare "is #501 equal to 20 yet?". A value is accepted only when the
 * conversion to a JavaScript number cannot round two different source
 * literals into the same number; otherwise it is treated as unknown.
 */
import { NUMBER_PATTERN } from '../nc/numbers.js';

const MAX_SIGNIFICANT_DIGITS = 15;
const WHOLE_NUMBER = new RegExp(`^${NUMBER_PATTERN}$`);

/**
 * Convert a macro literal ("20", "20.0", 20) to a number, or `undefined` when
 * it is not a finite literal within safe precision.
 */
export function macroNumber(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    if (Number.isInteger(value)) return Number.isSafeInteger(value) ? value : undefined;
    return Number(value.toPrecision(MAX_SIGNIFICANT_DIGITS)) === value ? value : undefined;
  }

  const literal = String(value ?? '').trim();
  if (!WHOLE_NUMBER.test(literal)) return undefined;
  const number = Number(literal);
  if (!Number.isFinite(number)) return undefined;

  const unsigned = literal.replace(/^[+-]/, '');
  const [integer, rawFraction = ''] = unsigned.split('.');
  const fraction = rawFraction.replace(/0+$/, '');
  const significantDigits = `${integer}${fraction}`.replace(/^0+/, '');
  // Keep distinct source literals distinct: JavaScript must not round either
  // one into a matching synchronization value. These are planning bounds, not
  // a claim about the controller's supported variable precision.
  if (fraction && (significantDigits.length > MAX_SIGNIFICANT_DIGITS || (number === 0 && significantDigits))) return undefined;
  if (Number.isInteger(number) && !Number.isSafeInteger(number)) return undefined;
  return number;
}

/** "#501" and "501" name the same variable. */
export function variableKey(variable) {
  return String(variable ?? '').replace(/^#/, '').trim();
}
