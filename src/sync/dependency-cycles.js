/**
 * Finds macro waits that can never be released because of a dependency loop.
 *
 * Example of a deadlock:
 *   H:  WHILE[#502NE1] ...  (waits for V)   then  #501=1
 *   V:  WHILE[#501NE1] ...  (waits for H)   then  #502=1
 * Each channel waits for an assignment the other only makes after its own wait.
 *
 * Model: a directed graph with one node per block.
 *   - each block points to the next block in its own channel (program order)
 *   - each macro assignment points to the wait it releases
 *   - both ends of a barrier are merged into one node (both pass it together)
 * A macro link inside a cycle of this graph is a possible deadlock. Cycles are
 * found as strongly connected components (Kosaraju's algorithm), written with
 * explicit stacks so long programs cannot overflow the call stack.
 */

/**
 * @returns {object[][]} for each cycle, the sync entries / blocks involved
 *          (as `{block, index, channel}`), for highlighting
 */
export function findMacroDependencyCycles(hBlocks, vBlocks, barrierPairs, macroPairs) {
  if (!macroPairs.length) return [];

  const entries = [
    ...hBlocks.map((block, index) => ({ block, index, channel: 'h' })),
    ...vBlocks.map((block, index) => ({ block, index, channel: 'v' })),
  ];
  const nodeOf = (entry) => entry.index + (entry.channel === 'v' ? hBlocks.length : 0);

  // Merge barrier ends with a union-find structure.
  const groups = new UnionFind(hBlocks.length + vBlocks.length);
  barrierPairs.forEach((pair) => groups.union(nodeOf(pair.h), nodeOf(pair.v)));

  const graph = new Graph();
  const link = (from, to) => graph.addEdge(groups.find(from), groups.find(to));
  for (let i = 1; i < hBlocks.length; i += 1) link(i - 1, i);
  for (let i = 1; i < vBlocks.length; i += 1) link(hBlocks.length + i - 1, hBlocks.length + i);
  macroPairs.forEach((pair) => link(nodeOf(pair.signal), nodeOf(pair.wait)));

  const { componentOf, components } = graph.stronglyConnectedComponents();

  const cyclic = new Set();
  macroPairs.forEach((pair) => {
    const from = groups.find(nodeOf(pair.signal));
    const to = groups.find(nodeOf(pair.wait));
    const id = componentOf.get(from);
    const sameComponent = id === componentOf.get(to);
    if (sameComponent && (from === to || components[id]?.length > 1)) cyclic.add(id);
  });

  return [...cyclic].map((id) => entries.filter((entry) => componentOf.get(groups.find(nodeOf(entry))) === id));
}

/** Disjoint sets with path compression. */
class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(node) {
    let root = node;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[node] !== node) {
      const next = this.parent[node];
      this.parent[node] = root;
      node = next;
    }
    return root;
  }

  /** Merge b's set into a's set. */
  union(a, b) {
    this.parent[this.find(b)] = this.find(a);
  }
}

/** Directed graph keeping forward and reverse edges. */
class Graph {
  constructor() {
    this.forward = new Map();
    this.reverse = new Map();
  }

  addEdge(from, to) {
    for (const node of [from, to]) {
      if (!this.forward.has(node)) this.forward.set(node, new Set());
      if (!this.reverse.has(node)) this.reverse.set(node, new Set());
    }
    this.forward.get(from).add(to);
    this.reverse.get(to).add(from);
  }

  /**
   * Kosaraju: order nodes by DFS finish time, then walk the reversed graph in
   * reverse finish order; each walk collects one component.
   * @returns {{componentOf: Map<number, number>, components: number[][]}}
   */
  stronglyConnectedComponents() {
    const visited = new Set();
    const finishOrder = [];
    for (const start of this.forward.keys()) {
      if (visited.has(start)) continue;
      const stack = [[start, false]];
      while (stack.length) {
        const [node, finished] = stack.pop();
        if (finished) {
          finishOrder.push(node);
          continue;
        }
        if (visited.has(node)) continue;
        visited.add(node);
        stack.push([node, true]);
        for (const next of this.forward.get(node) ?? []) if (!visited.has(next)) stack.push([next, false]);
      }
    }

    const componentOf = new Map();
    const components = [];
    for (const start of finishOrder.reverse()) {
      if (componentOf.has(start)) continue;
      const id = components.length;
      const component = [];
      const stack = [start];
      while (stack.length) {
        const node = stack.pop();
        if (componentOf.has(node)) continue;
        componentOf.set(node, id);
        component.push(node);
        for (const next of this.reverse.get(node) ?? []) if (!componentOf.has(next)) stack.push(next);
      }
      components.push(component);
    }
    return { componentOf, components };
  }
}
