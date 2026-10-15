/**
 * Dragging blocks within a channel.
 *
 * Three kinds of drop, decided while hovering:
 *   1. Before / after a block   ⠿ handle: the block moves to that gap.
 *   2. Whole toolpath           ⧉ handle: the toolpath (with its waits) moves,
 *                               and always lands between whole toolpaths.
 *   3. Inside a block's code    a single wait / macro block dragged over the
 *                               code lines of another block is inserted between
 *                               two lines, marked by a green line.
 * Blocks never move to the other channel.
 */
import { $, $$ } from './dom.js';
import { moveBlock, moveToolpath } from './editor-events.js';

/** Height of one code line in pixels; must match the CSS line-height of .code-input. */
const LINE_HEIGHT_PX = 19;

export function setupDragDrop(app) {
  const board = $('#aligned-board');

  board.addEventListener('dragstart', (event) => {
    if (!event.target.closest('.drag-handle')) {
      event.preventDefault(); // only the handles start a drag, not text selection
      return;
    }
    const article = event.target.closest('.block');
    app.drag = { channel: article.dataset.channel, id: article.dataset.id, group: !!event.target.closest('.group-handle') };
    event.dataTransfer.setData('text/plain', JSON.stringify(app.drag));
    event.dataTransfer.effectAllowed = 'move';
    article.classList.add('dragging');
  });

  board.addEventListener('dragover', (event) => {
    if (!app.drag) return;
    const target = event.target.closest('.block,.end-drop');
    if (!target || target.dataset.channel !== app.drag.channel) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    clearDropMarkers();

    const line = lineUnderPointer(app, event, target);
    if (line) {
      target.classList.add('drop-inside');
      target.dataset.dropLine = line;
      const textarea = $('.code-input', target);
      $('.code-input-wrap', target).style.setProperty('--drop-line', `${line * LINE_HEIGHT_PX - textarea.scrollTop}px`);
    } else if (target.classList.contains('end-drop')) {
      target.classList.add('over');
    } else {
      const upperHalf = event.clientY < target.getBoundingClientRect().top + target.clientHeight / 2;
      target.classList.add(upperHalf ? 'drop-before' : 'drop-after');
    }
  });

  board.addEventListener('drop', (event) => {
    if (!app.drag) return;
    event.preventDefault();
    const target = event.target.closest('.block,.end-drop');
    const drag = app.drag;

    if (!target || target.dataset.channel !== drag.channel) {
      app.toast('Move blocks within their original channel', true);
    } else if (target.dataset.dropLine) {
      dropInsideBlock(app, drag, target);
    } else if (drag.group) {
      dropToolpath(app, drag, target);
    } else {
      dropBlock(app, drag, target);
    }
    app.drag = null;
    clearDropMarkers();
  });

  board.addEventListener('dragend', () => {
    app.drag = null;
    app.pointerHeld = false;
    clearDropMarkers();
    $$('.dragging').forEach((element) => element.classList.remove('dragging'));
    app.flushQueuedRender();
  });
}

function dropBlock(app, drag, target) {
  const list = app.ws.blocks[drag.channel];
  const from = app.ws.indexOf(drag.channel, drag.id);
  const to = target.classList.contains('end-drop')
    ? list.length
    : app.ws.indexOf(drag.channel, target.dataset.id) + (target.classList.contains('drop-after') ? 1 : 0);
  moveBlock(app, drag.channel, from, to);
}

/** Snap to whole toolpaths: before the target's toolpath or after it. */
function dropToolpath(app, drag, target) {
  const { ws } = app;
  const block = ws.findBlock(drag.channel, drag.id);
  let to = ws.blocks[drag.channel].length;
  if (!target.classList.contains('end-drop')) {
    const range = ws.toolpathRange(drag.channel, ws.findBlock(drag.channel, target.dataset.id));
    to = target.classList.contains('drop-after') ? range.start + range.count : range.start;
  }
  moveToolpath(app, drag.channel, block, to);
}

function dropInsideBlock(app, drag, target) {
  const from = app.ws.indexOf(drag.channel, drag.id);
  app.ws.moveIntoLine(drag.channel, from, target.dataset.id, Number(target.dataset.dropLine));
  app.refreshAfterEdit();
  app.toast('Wait placed inside the code · alignment updated');
}

/**
 * The line gap inside `target`'s code under the pointer, or 0 when this is
 * not an inside-the-code drop. Only single sync blocks (waits, macro waits,
 * signals) can be dropped between lines, and not into pinned or sync blocks.
 */
function lineUnderPointer(app, event, target) {
  const drag = app.drag;
  if (drag.group || target.classList.contains('end-drop') || target.dataset.id === drag.id) return 0;
  const dragged = app.ws.findBlock(drag.channel, drag.id);
  const into = app.ws.findBlock(drag.channel, target.dataset.id);
  if (!dragged?.sync || !into || into.sync || app.ws.isPinned(into)) return 0;

  const wrap = $('.code-input-wrap', target);
  const textarea = $('.code-input', target);
  if (!wrap || !textarea) return 0;
  const top = wrap.getBoundingClientRect().top;
  const line = Math.round((event.clientY - top + textarea.scrollTop) / LINE_HEIGHT_PX);
  const lineCount = textarea.value.split('\n').length;
  // Gap 0 (above the first line) and the gap after the last line are ordinary before/after drops.
  return event.clientY >= top && line > 0 && line < lineCount ? line : 0;
}

function clearDropMarkers() {
  $$('.drop-before,.drop-after,.drop-inside,.end-drop.over').forEach((element) => {
    element.classList.remove('drop-before', 'drop-after', 'drop-inside', 'over');
    delete element.dataset.dropLine;
  });
}
