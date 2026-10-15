/**
 * Manual block times.
 *
 * When the user types a measured time for a block (for example from the
 * machine simulator), that time replaces every modeled or unknown time action
 * in the block. Sync actions in the block are kept in place. The replacement
 * is categorized as cut, air or tool change by what the block mostly does.
 */

/**
 * @param {object[]} actions   the block's actions from motion.js
 * @param {number} seconds     manual time, already validated (finite, >= 0)
 * @param {object} block       parsed block (for its flags)
 * @param {string} cleanText   comment-free block text
 * @returns {object[]} new action list
 */
export function applyManualTime(actions, seconds, block, cleanText, blockId) {
  const replacement = { kind: 'time', duration: seconds, type: dominantWork(actions, block, cleanText), blockId, label: 'Manual block time' };

  // Put the manual time where the first time action was, keeping sync actions in order.
  const result = [];
  let inserted = false;
  for (const action of actions) {
    if (action.kind !== 'time') {
      result.push(action);
    } else if (!inserted) {
      result.push(replacement);
      inserted = true;
    }
  }
  if (!inserted) result.unshift(replacement);
  return result;
}

/**
 * Read an override value. Returns the number of seconds, or null when there
 * is none, or NaN when the stored value is not a valid time.
 */
export function readOverride(raw) {
  if (raw === undefined) return null;
  const seconds = raw !== '' && raw !== null ? Number(raw) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : NaN;
}

/** 'toolChange', 'cut' or 'air': what most of the block's time is spent on. */
function dominantWork(actions, block, cleanText) {
  const total = (type) => actions.filter((action) => action.type === type).reduce((sum, action) => sum + action.duration, 0);
  if (block.flags?.toolChange || total('toolChange') > Math.max(total('cut'), total('air'))) return 'toolChange';
  if (total('cut') > 0) return 'cut';
  if (block.flags?.rotation || total('air') > 0) return 'air';
  return /G0*[123](?=[A-Z\s]|$)/i.test(cleanText) ? 'cut' : 'air';
}
