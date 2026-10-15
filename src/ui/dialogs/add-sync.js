/**
 * "Add sync" dialog: inserts a matching pair of synchronization statements.
 *
 *   Paired wait   the same wait code in both programs, from the template in
 *                 Settings, e.g. M{id}P{p} -> M303P12
 *   Shared macro  "#501=20" in the producing channel and
 *                 "WHILE[#501NE20]DO1 / END1" in the waiting channel
 *
 * The code goes after the selected block in its channel and before the
 * program end in the other; the user then drags each into place.
 */
import { $ } from '../dom.js';
import { parseProgram } from '../../nc/parser.js';

export function setupAddSyncDialog(app) {
  const form = $('#sync-form');
  form.addEventListener('input', updatePreview.bind(null, app));

  $('#add-sync-btn').onclick = () => {
    $('#sync-error').textContent = '';
    form.elements.participants.value = app.ws.state.settings.hChannel + app.ws.state.settings.vChannel;
    const block = app.selectedBlock();
    $('#insert-location').textContent = block && !app.ws.isPinned(block)
      ? `After “${block.title}” in the selected channel; before program end in the other. Drag either inserted block to adjust.`
      : 'Insert before each program end. Drag the new blocks to their desired positions.';
    updatePreview(app);
    $('#sync-dialog').showModal();
  };

  form.onsubmit = (event) => {
    event.preventDefault();
    const texts = syncCode(app);
    const type = $('#sync-type').value;
    if (type === 'barrier') {
      // Make sure the template produces something the wait pattern recognizes.
      const check = parseProgram(`${texts.h}\n`, app.ws.state.settings, 'test');
      if (!check.blocks.some((block) => block.kind === 'wait')) {
        $('#sync-error').textContent = 'This template does not match your wait pattern. Update Settings first.';
        return;
      }
    }
    app.ws.insertSync(texts, app.ui.selected);
    $('#sync-dialog').close();
    app.refreshAfterEdit();
    app.toast(type === 'barrier' ? 'Paired wait inserted' : 'Shared macro signal and wait inserted');
  };
}

/** The code to insert in each channel, from the form values. */
function syncCode(app) {
  const data = Object.fromEntries(new FormData($('#sync-form')));
  if (data.type === 'barrier') {
    const code = app.ws.state.settings.waitTemplate.replaceAll('{id}', data.value).replaceAll('{p}', data.participants);
    return { h: code, v: code };
  }
  const signal = `#${data.variable}=${data.value}`;
  const wait = `WHILE[#${data.variable}NE${data.value}]DO1\nEND1`;
  return data.producer === 'h' ? { h: signal, v: wait } : { h: wait, v: signal };
}

/** Show the fields for the chosen type and a preview of the code. */
function updatePreview(app) {
  const isMacro = $('#sync-type').value === 'macro';
  $('#p-field').hidden = isMacro;
  $('#variable-field').hidden = !isMacro;
  $('#producer-field').hidden = !isMacro;
  const texts = syncCode(app);
  $('#sync-preview').textContent = `HORIZONTAL\n${texts.h}\n\nVERTICAL\n${texts.v}`;
}
