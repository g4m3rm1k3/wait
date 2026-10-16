/**
 * Turns per-op times (from a Mastercam op list) into manual block times.
 *
 * The parser splits one op into several blocks around its sync code, e.g. H:
 *   retract | WAIT FOR V | B move / tool change | B IN POSITION | cut ... N5
 * and V:
 *   tool change | V CLEAR | WAIT FOR B | B calculation, cut ... N107
 * Each op's time goes where it happens: `pre` (H's B move, V's tool change) on
 * the work block just before the op's last sync block, the rest on the op's
 * last block, 0 on anything else. Ops are counted by toolpath blocks (N lines).
 */

/**
 * @param {{h: object[], v: object[]}} blocks  parsed blocks per channel
 * @param {{h: {seconds: number, pre: number}[], v: {seconds: number, pre: number}[]}} times
 * @returns {Record<string, number>} block id -> seconds
 */
export function opTimesToOverrides(blocks, times) {
  const overrides = {};
  for (const channel of ['h', 'v']) {
    let op = 0;
    let current = [];
    for (const block of blocks[channel]) {
      current.push(block);
      if (block.kind !== 'toolpath') continue;
      const time = times[channel][op];
      if (time) assignOp(current, time, overrides);
      op += 1;
      current = [];
    }
  }
  return overrides;
}

function assignOp(opBlocks, { seconds, pre }, overrides) {
  const work = opBlocks.filter((block) => !block.sync);
  const last = work[work.length - 1];
  const lastSync = opBlocks.findLastIndex((block) => block.sync);
  const preBlock = pre && lastSync >= 0 ? opBlocks.slice(0, lastSync).filter((block) => !block.sync).at(-1) : null;
  for (const block of work) {
    if (block === last) overrides[block.id] = seconds - (preBlock ? pre : 0);
    else overrides[block.id] = block === preBlock ? pre : 0;
  }
}
