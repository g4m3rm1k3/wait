/**
 * Keyboard shortcuts.
 *
 *   Ctrl+Z / Ctrl+Shift+Z   undo / redo (outside text boxes; text boxes keep their own undo)
 *   Ctrl+S                  apply pending edits and save in this browser
 *   Alt+↑ / Alt+↓           move the selected block
 *   Alt+Shift+↑ / ↓         move the selected block's whole toolpath
 *   Ctrl+Shift+F / Esc      enter / leave Focus mode (see focus-mode.js)
 * On a Mac, Cmd works in place of Ctrl.
 */
import { moveBlock, moveToolpath } from './editor-events.js';
import { toggleFocusMode, isFocusMode } from './focus-mode.js';

export function setupKeyboard(app) {
  document.addEventListener('keydown', (event) => {
    const inText = /^(TEXTAREA|INPUT)$/.test(event.target.tagName);
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const arrow = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;

    if (ctrl && event.shiftKey && key === 'f') {
      event.preventDefault();
      toggleFocusMode();
    }
    if (event.key === 'Escape' && !inText && !document.querySelector('dialog[open]') && isFocusMode()) {
      toggleFocusMode(false);
    }
    if (ctrl && key === 'z' && !inText) {
      event.preventDefault();
      if (event.shiftKey) app.redo();
      else app.undo();
    }
    if (ctrl && key === 's') {
      event.preventDefault();
      document.activeElement.blur(); // commits an in-place edit
      app.applySourceDrafts();
      app.save();
      app.toast('Workspace saved in this browser');
    }
    if (event.altKey && arrow && app.ui.selected) {
      event.preventDefault();
      moveSelected(app, arrow, event.shiftKey, event.target);
    }
  });
}

/** Alt+arrow: move the selected block one step, or with Shift its whole toolpath. */
function moveSelected(app, direction, wholeToolpath, target) {
  if (target.matches('.code-input')) app.commitEdit(target); // apply typing first
  const selected = app.ui.selected;
  if (!selected) return; // the edit may have removed the block
  const { ws } = app;
  const block = ws.findBlock(selected.channel, selected.id);

  if (wholeToolpath) {
    if (block && !ws.isPinned(block)) moveToolpath(app, selected.channel, block, ws.neighbourToolpathGap(selected.channel, block, direction));
    return;
  }
  const index = ws.indexOf(selected.channel, selected.id);
  const to = direction < 0 ? index - 1 : index + 2; // insertion gap past the neighbour
  if (to >= 0 && to <= ws.blocks[selected.channel].length) moveBlock(app, selected.channel, index, to);
}
