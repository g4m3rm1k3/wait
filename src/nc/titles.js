/** Fixed block titles. Other modules recognise special blocks by these exact strings. */
export const TITLE_PROGRAM_HEADER = 'Program header';
export const TITLE_PROGRAM_END = 'Program end';
export const TITLE_COMMENTS = 'Comments / spacing';
export const TITLE_LOOP_KEPT = 'Macro loop (kept together)';
export const TITLE_UNKNOWN_LOOP = 'Unrecognized macro loop (kept together)';
export const TITLE_MULTIPLE_WAITS = 'Multiple waits on one line (kept together)';

/** Program header / end blocks are pinned: they cannot be moved. */
export function isProgramBoundary(block) {
  return block.title === TITLE_PROGRAM_HEADER || block.title === TITLE_PROGRAM_END;
}
