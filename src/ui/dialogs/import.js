/**
 * Import dialog: choose NC files or paste the two programs.
 *
 * Files are read as UTF-8 / ASCII. When the text area still holds exactly the
 * file's content, the original bytes (including \r\n line endings) are kept;
 * once the user edits the pasted text, the edited text is used.
 */
import { $, CHANNELS } from '../dom.js';

export function setupImportDialog(app) {
  let files = {}; // channel -> { source, normalized, filename }

  $('#import-btn').onclick = () => {
    for (const channel of CHANNELS) {
      $(`#import-${channel}`).value = '';
      $(`#file-${channel}`).value = '';
    }
    files = {};
    $('#import-error').textContent = '';
    $('#import-dialog').showModal();
  };

  for (const channel of CHANNELS) {
    $(`#file-${channel}`).onchange = async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
        $(`#import-${channel}`).value = source;
        files[channel] = { source, normalized: source.replace(/\r\n|\r/g, '\n'), filename: file.name };
      } catch {
        $('#import-error').textContent = 'Use ASCII or UTF-8 NC text. This file could not be decoded.';
      }
    };
  }

  $('#import-form').onsubmit = (event) => {
    event.preventDefault();
    if (!$('#import-h').value.trim() && !$('#import-v').value.trim()) {
      $('#import-error').textContent = 'Choose or paste at least one channel program.';
      return;
    }
    const programs = {};
    for (const channel of CHANNELS) {
      const text = $(`#import-${channel}`).value;
      const file = files[channel];
      programs[channel] = {
        source: file?.normalized === text ? file.source : text,
        filename: file?.filename || `${channel === 'h' ? 'horizontal' : 'vertical'}.nc`,
      };
    }
    app.ws.importPrograms(programs);
    app.ui.sourceDrafts = {};
    app.ui.selected = null;
    $('#import-dialog').close();
    app.refreshAfterEdit();
    app.toast('Programs imported');
  };

  $('#demo-btn').onclick = () => {
    app.ws.loadExample();
    app.ui.selected = null;
    app.ui.sourceDrafts = {};
    app.refreshAfterEdit();
    app.toast('Example programs loaded');
  };
}
