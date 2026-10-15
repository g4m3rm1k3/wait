/**
 * Groups blocks into toolpaths.
 *
 * Rule: a toolpath is every block up to and including the block that ends
 * with its N line. Waits and B-axis indexes placed in the middle of a path
 * therefore stay part of that path:
 *
 *     (FINISH SIDES)       part 1/5   code
 *     G1 X60 ...
 *     M303P12              part 2/5   wait
 *     G0 B180.             part 3/5   code  -> titled "B index → B180. · N40"
 *     M304P12              part 4/5   wait
 *     G1 X0 ...            part 5/5   toolpath (ends with the N line)
 *     N40
 *
 * The members of one toolpath are always next to each other, so a toolpath
 * can be moved as one range of blocks (see edit.js `moveRange`).
 */
import { isProgramBoundary, TITLE_COMMENTS, TITLE_LOOP_KEPT, TITLE_UNKNOWN_LOOP, TITLE_MULTIPLE_WAITS } from './titles.js';

/** Titles that already say something more useful than the toolpath name. */
const KEEP_TITLES = new Set([TITLE_COMMENTS, TITLE_LOOP_KEPT, TITLE_UNKNOWN_LOOP, TITLE_MULTIPLE_WAITS]);

/**
 * Set `block.toolpath = { n, label, part, parts }` on each member of a toolpath,
 * and rename unnamed pieces of split toolpaths. Mutates `blocks` in place.
 * Blocks after the last N line (before M30) are left without a toolpath.
 */
export function assignToolpaths(blocks) {
  let members = [];
  for (const block of blocks) {
    if (isProgramBoundary(block)) {
      members = [];
      continue;
    }
    members.push(block);
    if (block.kind !== 'toolpath') continue;

    // `block` ends with the N line: everything collected so far is one toolpath.
    const comment = members.find((member) => !member.sync && member.comment)?.comment;
    const label = comment ? `${comment} · ${block.terminalN}` : `Toolpath ${block.terminalN}`;
    members.forEach((member, index) => {
      member.toolpath = { n: block.terminalN, label, part: index + 1, parts: members.length };
      if (members.length > 1) retitlePart(member, block, label);
    });
    members = [];
  }
}

/** Give a piece of a split toolpath a name that shows what it is and where it belongs. */
function retitlePart(member, lastPart, label) {
  if (member.sync || KEEP_TITLES.has(member.title)) return; // waits keep their own titles

  const code = member.text.replace(/\([^)]*\)|;[^\r\n]*/g, '');
  const bTarget = [...code.matchAll(/\bB\s*([+-]?[\d.]+)/gi)].at(-1)?.[1];
  const cutsOrChangesTool = /\bG\s*0*[123](?![\d.])/i.test(code) || /\bM\s*0*6(?![\d.])/i.test(code);

  if (member.flags.rotation && !cutsOrChangesTool && !member.comment) {
    member.title = `B index${bTarget ? ` → B${bTarget}` : ''} · ${lastPart.terminalN}`;
  } else if (!member.comment || member === lastPart) {
    member.title = label;
  }
}
