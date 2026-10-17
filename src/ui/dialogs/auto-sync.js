/** Preview automatic wait placement before committing a single workspace edit. */
import { $, escapeHtml, formatTime } from '../dom.js';
import { analyzePathEnvelopes } from '../../sync/path-envelopes.js';

export function setupAutoSyncDialog(app) {
  const form = $('#auto-sync-form');
  let preview = null;

  function invalidate() {
    preview = null;
    $('#apply-auto-sync').disabled = true;
    $('#auto-sync-summary').textContent = '';
    $('#auto-sync-error').textContent = '';
    $('#auto-sync-results').hidden = true;
    $('#auto-path-results').hidden = true;
  }

  function commitDrafts() {
    app.commitFocusedEdit();
    app.applySourceDrafts();
  }

  function showPreview() {
    invalidate();
    if (!form.reportValidity()) return;
    commitDrafts();
    try {
      const pathGeometry = readGeometry(form, app.ws.state.settings.pathGeometry);
      renderPathReport(analyzePathEnvelopes(app.ws.state.sources, { ...app.ws.state.settings, pathGeometry }));
      preview = app.ws.previewWaitCodes({
        startId: Number(form.elements.startId.value),
        participants: form.elements.participants.value,
        pathGeometry,
      });
      if (preview.errors.length) {
        $('#auto-sync-error').textContent = preview.errors.join('\n');
        preview = null;
        return;
      }
      const longer = preview.longerChannel === 'v' ? 'Vertical' : 'Horizontal';
      const overlap = preview.rows.filter((row) => row.mode === 'overlap').length;
      $('#auto-sync-summary').textContent = `${preview.rows.length} vertical releases · ${overlap} overlapping · estimated cycle ${formatTime(preview.timing.duration)}. ${longer} has more work. H waiting ${formatTime(preview.timing.channels.h.wait)} · V waiting ${formatTime(preview.timing.channels.v.wait)}.`;
      const results = $('#auto-sync-results');
      results.innerHTML = `<table><thead><tr><th>H event</th><th>V event</th><th>Placement</th><th>Wait IDs</th><th>Sync lifecycle</th></tr></thead><tbody>${preview.rows.map((row) => `<tr>
        <td>${escapeHtml(String(row.hEvent))}</td><td>${escapeHtml(String(row.vEvent))}</td>
        <td>${escapeHtml(row.mode)}<span class="field-hint">${escapeHtml(row.reason || '')}</span></td>
        <td><code>${escapeHtml(String(row.releaseId))} / ${escapeHtml(String(row.completeId))}</code></td>
        <td><code>2(wait) → 2(release)<br>1(wait) → 1(release)</code><span class="field-hint">Pair ${escapeHtml(String(row.pair_id))}</span></td>
      </tr>`).join('')}</tbody></table>${preview.notes.map((note) => `<p class="field-hint">${escapeHtml(typeof note === 'string' ? note : note.message)}</p>`).join('')}`;
      results.hidden = false;
      $('#apply-auto-sync').disabled = false;
    } catch (error) {
      preview = null;
      $('#auto-sync-error').textContent = error.message;
    }
  }

  $('#auto-sync-btn').onclick = () => {
    commitDrafts();
    invalidate();
    form.elements.participants.value = app.ws.state.settings.hChannel + app.ws.state.settings.vChannel;
    const geometry = app.ws.state.settings.pathGeometry;
    form.elements.pathClearance.value = geometry?.clearance ?? '';
    form.elements.initialHY.value = geometry?.initialPositions?.h?.y ?? '';
    form.elements.initialVY.value = geometry?.initialPositions?.v?.y ?? '';
    $('#auto-sync-dialog').showModal();
  };
  form.elements.startId.addEventListener('input', invalidate);
  form.elements.participants.addEventListener('input', invalidate);
  for (const name of ['pathClearance', 'initialHY', 'initialVY']) form.elements[name].addEventListener('input', invalidate);
  $('#preview-auto-sync').onclick = showPreview;
  form.onsubmit = (event) => {
    event.preventDefault();
    if (!preview) return;
    try {
      app.ws.applyWaitPlan(preview);
      app.ui.sourceDrafts = {};
      $('#auto-sync-dialog').close();
      app.refreshAfterEdit();
      app.toast('Automatic wait codes applied · Undo restores the previous programs');
    } catch (error) {
      invalidate();
      $('#auto-sync-error').textContent = error.message;
    }
  };
  $('#clear-waits-btn').onclick = () => {
    commitDrafts();
    invalidate();
    try {
      const cleared = app.ws.clearWaitCodes($('#clear-wait-scope').value);
      app.ui.sourceDrafts = {};
      app.refreshAfterEdit();
      $('#auto-sync-summary').textContent = `${cleared.removed} wait codes removed. ${cleared.notes.join(' ')}`;
      app.toast(cleared.removed ? 'Wait codes cleared · Undo restores them' : 'No matching wait codes found');
    } catch (error) {
      $('#auto-sync-error').textContent = error.message;
    }
  };
}

function renderPathReport(report) {
  const target = $('#auto-path-results');
  const conflicts = report.conflicts.filter((pair) => pair.kind !== 'separated');
  const possible = conflicts.filter((pair) => pair.kind === 'possible-overlap').length;
  const unresolved = conflicts.length - possible;
  const operations = ['h', 'v'].flatMap((channel) => report.operations[channel].map((op) => ({ ...op, channel })));
  const rangeText = (range) => range?.map((n) => Number(n.toFixed(3))).join('…');
  const boundsText = (op) => op.yRange ? `Y ${rangeText(op.yRange)}` : op.bounds ? ['x', 'y', 'z'].map((axis) => `${axis.toUpperCase()} ${rangeText(op.bounds[axis])}`).join(' · ') : 'Unknown';
  target.innerHTML = `<div class="form-section-label">Programmed path envelopes</div>
    <p class="field-hint">${possible} possible path overlaps · ${unresolved} unresolved pairs. Y ranges include approach and retract. Tool and holder clearance, offsets and orientation must be resolved before separation can authorize overlap.</p>
    <table><thead><tr><th>Operation</th><th>Tool / frame</th><th>Path range (mm)</th><th>Unresolved geometry</th></tr></thead><tbody>${operations.slice(0, 100).map((op) => `<tr>
      <td>${op.channel.toUpperCase()} ${escapeHtml(String(op.n || op.event))}</td>
      <td>${op.tool == null ? '—' : `T${escapeHtml(String(op.tool))}`}<span class="field-hint">${escapeHtml(op.frame)}</span></td>
      <td><code>${escapeHtml(boundsText(op))}</code></td>
      <td>${escapeHtml(op.unresolved.join(' ')) || 'Modeled with configured clearance'}</td>
    </tr>`).join('')}</tbody></table>
    ${conflicts.length ? `<table><thead><tr><th>H event</th><th>V event</th><th>Path check</th></tr></thead><tbody>${conflicts.slice(0, 100).map((pair) => `<tr><td>${escapeHtml(String(pair.hN || pair.hEvent))}</td><td>${escapeHtml(String(pair.vN || pair.vEvent))}</td><td>${escapeHtml(pair.kind)}<span class="field-hint">${escapeHtml(pair.reasons.join(' '))}</span></td></tr>`).join('')}</tbody></table>` : ''}
    ${operations.length > 100 || conflicts.length > 100 ? '<p class="field-hint">Showing the first 100 rows of each table.</p>' : ''}
    ${report.notes.map((note) => `<p class="field-hint">${escapeHtml(note)}</p>`).join('')}`;
  target.hidden = false;
}

function readGeometry(form, existing) {
  const values = ['pathClearance', 'initialHY', 'initialVY'].map((name) => form.elements[name].value.trim());
  if (values.every((value) => !value)) return existing;
  if (values.some((value) => !value) || values.some((value) => !Number.isFinite(Number(value))) || !(Number(values[0]) > 0)) {
    throw new Error('Enter a positive Y separation and both known starting Y positions, or leave all three fields empty.');
  }
  return { sharedAxis: 'y', clearance: Number(values[0]), initialPositions: { h: { y: Number(values[1]) }, v: { y: Number(values[2]) } } };
}
