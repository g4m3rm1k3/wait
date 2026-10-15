/**
 * Chooses which cross-channel pairs can share a display row.
 *
 * Rows keep both programs in source order, so the chosen pairs must increase
 * in BOTH channels: if pair A is above pair B on the horizontal side, it must
 * also be above it on the vertical side. Among all such choices we keep:
 *   1. the most barriers (paired waits are what really hold the machine), then
 *   2. the most pairs overall, then
 *   3. the earliest pairs on ties.
 *
 * This is a weighted "longest increasing subsequence". A Fenwick tree (binary
 * indexed tree) over vertical positions makes it O(n log n), so programs with
 * many toolpaths stay fast.
 */

/** Sort pairs by horizontal position, then vertical position. */
export function byHorizontalIndex(a, b) {
  return a.h.index - b.h.index || a.v.index - b.v.index;
}

/**
 * @param {{h: {index: number}, v: {index: number}, kind: string}[]} pairs
 * @param {number} verticalCount  Number of vertical blocks (size of the tree).
 * @returns the chosen pairs, in order
 */
export function bestIncreasingPairs(pairs, verticalCount) {
  const ordered = [...pairs].sort(byHorizontalIndex);

  // tree[i] holds the best chain ending at a vertical position covered by i.
  const tree = new Array(verticalCount + 1).fill(null);
  const bestUpTo = (position) => {
    let best = null;
    for (let i = position; i > 0; i -= i & -i) best = better(best, tree[i]);
    return best;
  };
  const record = (position, chain) => {
    for (let i = position; i < tree.length; i += i & -i) tree[i] = better(tree[i], chain);
  };

  for (let cursor = 0; cursor < ordered.length;) {
    // Pairs on the same horizontal block cannot follow each other, so compute
    // the whole batch before recording any of them.
    const batch = [];
    const hIndex = ordered[cursor].h.index;
    while (cursor < ordered.length && ordered[cursor].h.index === hIndex) {
      const pair = ordered[cursor];
      const previous = bestUpTo(pair.v.index); // best chain strictly above this vertical position
      batch.push({
        pair,
        previous,
        barriers: (previous?.barriers ?? 0) + Number(pair.kind === 'barrier'),
        count: (previous?.count ?? 0) + 1,
        ordinal: cursor,
      });
      cursor += 1;
    }
    batch.forEach((chain) => record(chain.pair.v.index + 1, chain));
  }

  // Follow the best chain back to its start.
  const result = [];
  for (let chain = bestUpTo(verticalCount); chain; chain = chain.previous) result.push(chain.pair);
  return result.reverse();
}

/** The preferred of two chains (either may be null). */
function better(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.barriers !== b.barriers) return a.barriers > b.barriers ? a : b;
  if (a.count !== b.count) return a.count > b.count ? a : b;
  return a.ordinal < b.ordinal ? a : b;
}
