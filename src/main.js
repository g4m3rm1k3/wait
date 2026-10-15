/**
 * Spindle Sync — entry point loaded by index.html.
 *
 * Where things live:
 *   nc/       reading NC programs: lines, numbers, wait pattern, parser,
 *             toolpath grouping, and edits (move / insert)
 *   sync/     lining the two channels up at their waits, and finding
 *             crossed waits, macro races and deadlocks
 *   timing/   the cycle-time estimate: G-code -> timed actions -> two-channel
 *             schedule -> totals
 *   ui/       everything on screen; app.js is the controller
 *   styles/   CSS, one file per screen area
 */
import { App } from './ui/app.js';
import { setupEditorEvents } from './ui/editor-events.js';
import { setupDragDrop } from './ui/drag-drop.js';
import { setupKeyboard } from './ui/keyboard.js';
import { setupFocusMode } from './ui/focus-mode.js';
import { setupDialogClosing } from './ui/dialogs/common.js';
import { setupSettingsDialog } from './ui/dialogs/settings.js';
import { setupImportDialog } from './ui/dialogs/import.js';
import { setupAddSyncDialog } from './ui/dialogs/add-sync.js';
import { setupExportDialog } from './ui/dialogs/export.js';

const app = new App();

setupEditorEvents(app);
setupDragDrop(app);
setupKeyboard(app);
setupFocusMode();
setupDialogClosing();
setupSettingsDialog(app);
setupImportDialog(app);
setupAddSyncDialog(app);
setupExportDialog(app);

// Apply a half-finished edit before the page closes, so it is saved.
window.addEventListener('beforeunload', () => {
  app.commitFocusedEdit();
  app.applySourceDrafts();
});

app.start();
