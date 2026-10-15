/**
 * Export dialog: download each NC program, or the whole workspace as JSON,
 * and restore a workspace from a JSON backup.
 * NC downloads contain only the program text; alignment spacers are display only.
 */
import { $, CHANNELS, channelName, downloadFile } from '../dom.js';
import { validateProject } from '../workspace.js';

export function setupExportDialog(app) {
  $('#export-btn').onclick = () => {
    app.applySourceDrafts();
    const { alignment, timing } = app.ws;
    const errors = [...(alignment.diagnostics || []), ...(timing.diagnostics || [])].filter((note) => (note.level || note.severity) === 'error').length;
    $('#export-review').textContent = `${errors ? `${errors} unresolved issue(s). ` : ''}Review programs in your machine simulator before use. Workspace JSON preserves programs, configuration and time overrides.`;
    $('#export-dialog').showModal();
  };

  for (const channel of CHANNELS) {
    $(`#export-${channel}`).onclick = () => {
      const name = `${app.ws.state.filenames[channel].replace(/\.[^.]+$/, '')}.nc`;
      downloadFile(app.ws.state.sources[channel], name);
      app.toast(`${channelName(channel)} program downloaded`);
    };
  }

  $('#export-project').onclick = () => {
    downloadFile(JSON.stringify(app.ws.toProject(), null, 2), 'spindle-sync-workspace.json', 'application/json');
    app.toast('Workspace backup downloaded');
  };

  $('#restore-project').onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const project = validateProject(JSON.parse(await file.text()));
      app.ws.remember();
      app.ws.restore(project);
      app.afterRestore();
      $('#export-dialog').close();
      app.toast('Workspace restored');
    } catch (error) {
      app.toast(error.message || 'Could not restore workspace', true);
    }
    event.target.value = '';
  };
}
