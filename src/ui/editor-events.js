/**
 * Mouse and typing events inside the editor and the inspector panel:
 * selecting blocks, the ↑/↓ buttons, in-place editing, Source view,
 * manual block times, removing a block, and "Locate" links.
 */
import { $, channelName } from './dom.js';

export function setupEditorEvents(app) {
  const board = $('#aligned-board');

  // --- Selecting and the ↑ / ↓ buttons ---------------------------------------
  board.addEventListener('focusin', (event) => {
    const article = event.target.closest('.block');
    if (article) app.select(article.dataset.channel, article.dataset.id);
  });
  board.addEventListener('click', (event) => {
    const article = event.target.closest('.block');
    if (!article) return;
    app.select(article.dataset.channel, article.dataset.id);
    const direction = event.target.dataset.move;
    if (direction) {
      const index = app.ws.indexOf(article.dataset.channel, article.dataset.id);
      // Insertion gaps: "up" = before the previous block, "down" = after the next one.
      moveBlock(app, article.dataset.channel, index, direction === 'up' ? index - 1 : index + 2);
    }
  });

  // --- Editing code in place ---------------------------------------------------
  board.addEventListener('input', (event) => {
    if (event.target.matches('.code-input')) app.updateEditingBlock(event.target);
  });
  board.addEventListener('focusout', (event) => {
    // A redraw also removes focus; only a real "leave the block" commits.
    if (!app.rendering && event.target.matches('.code-input')) app.commitEdit(event.target);
  });
  // Keep the colour layer under the textarea when it scrolls sideways.
  board.addEventListener('scroll', (event) => {
    if (!event.target.matches('.code-input')) return;
    event.target.previousElementSibling.style.transform = `translate(${-event.target.scrollLeft}px,${-event.target.scrollTop}px)`;
  }, true);

  // --- Tabs, compact view, undo buttons -------------------------------------------
  $('#aligned-tab').onclick = () => app.setView('aligned');
  $('#source-tab').onclick = () => app.setView('source');
  $('#undo-btn').onclick = () => app.undo();
  $('#redo-btn').onclick = () => app.redo();
  $('#collapse-btn').onclick = () => {
    app.ws.setCompact(!app.ws.state.compact);
    app.render();
    app.save();
  };
  $('#dismiss-demo').onclick = () => { $('#demo-banner').hidden = true; };

  // --- Source view -----------------------------------------------------------------
  $('#source-board').addEventListener('input', (event) => {
    if (!event.target.id.startsWith('source-')) return;
    const channel = event.target.id.slice(-1);
    app.ui.sourceDrafts[channel] = event.target.value;
    $('#save-status').textContent = 'Source edits unapplied';
    $('.source-top>span', event.target.closest('.source-channel')).textContent = `${channelName(channel)} · full source · unapplied`;
  });
  $('#source-board').addEventListener('click', (event) => {
    const channel = event.target.dataset.applySource;
    if (!channel) return;
    const text = $(`#source-${channel}`).value;
    const current = app.ws.state.sources[channel];
    if (text === current.replace(/\r\n|\r/g, '\n')) return;
    app.ws.setSources({ [channel]: app.withOriginalLineEndings(text, current, channel) });
    delete app.ui.sourceDrafts[channel];
    app.refreshAfterEdit();
    app.toast(`${channelName(channel)} source applied`);
  });

  // --- Inspector: manual time, remove block, review notes -----------------------
  const details = $('#selection-details');
  details.addEventListener('keydown', (event) => {
    if (event.target.id === 'duration-override' && event.key === 'Enter') {
      event.preventDefault();
      applyDuration(app);
    }
  });
  details.addEventListener('click', (event) => {
    const selected = app.ui.selected;
    if (event.target.id === 'apply-duration') applyDuration(app);
    if (event.target.id === 'reset-duration' && selected) {
      app.ws.setOverride(selected.id, null);
      app.refreshAfterEdit();
    }
    if (event.target.id === 'delete-block' && selected) {
      app.ws.removeBlock(selected.channel, selected.id);
      app.ui.selected = null;
      app.refreshAfterEdit();
      app.toast('Block removed · undo available');
    }
  });
  $('#diagnostics').addEventListener('click', (event) => {
    const id = event.target.dataset.findBlock;
    if (!id) return;
    event.preventDefault();
    app.revealBlock(id);
  });
  $('#diagnostics-toggle').onclick = () => {
    const hidden = !$('#diagnostics').hidden;
    $('#diagnostics').hidden = hidden;
    $('#diagnostics-toggle').setAttribute('aria-expanded', String(!hidden));
  };
}

/** Move one block and tell the user. Shared by buttons, keyboard and drag. */
export function moveBlock(app, channel, from, to) {
  if (!app.ws.moveBlock(channel, from, to)) return;
  app.refreshAfterEdit();
  app.toast('Block moved · alignment updated');
}

/** Move a whole toolpath with the waits inside it. */
export function moveToolpath(app, channel, block, to) {
  const count = app.ws.toolpathRange(channel, block).count;
  if (!app.ws.moveToolpath(channel, block, to)) return;
  app.refreshAfterEdit();
  app.toast(`Toolpath ${block.toolpath?.n || ''} moved with all ${count} parts`);
}

function applyDuration(app) {
  const input = $('#duration-override');
  const selected = app.ui.selected;
  if (!input || !selected) return;
  const value = input.value;
  const invalid = value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0);
  if (!input.checkValidity() || invalid) {
    input.reportValidity();
    return;
  }
  app.ws.setOverride(selected.id, value === '' ? null : Number(value));
  app.refreshAfterEdit();
  app.toast('Block duration updated');
}

