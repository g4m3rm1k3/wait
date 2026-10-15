/**
 * The app controller: owns the workspace and the on-screen state (selection,
 * current view, unapplied source edits), and redraws the page after changes.
 *
 * Feature modules (drag-drop.js, keyboard.js, dialogs/...) receive this
 * object and call its methods; none of them touch the workspace without
 * going through `app.refresh()` or `app.render()` afterwards.
 */
import { $, $$, CHANNELS } from './dom.js';
import { Workspace } from './workspace.js';
import { renderBoard, renderSourceView, highlightNc, lineNumbers } from './board.js';
import { renderInsights, renderSelectionDetails } from './insights.js';

const TOAST_SECONDS = 4.2;

export class App {
  constructor() {
    this.ws = new Workspace();
    this.ui = {
      selected: null, // { channel, id } of the selected block
      view: 'aligned', // 'aligned' | 'source'
      sourceDrafts: {}, // channel -> text typed in Source view, not yet applied
    };
    /** Drag in progress: { channel, id, group } (see drag-drop.js). */
    this.drag = null;

    // Redrawing replaces every textarea, which makes the focused one fire
    // "focusout". These flags stop that from being treated as an edit, and
    // delay a redraw until the mouse button is released, so a click that
    // finished an edit still lands on the button the user aimed at.
    this.rendering = false;
    this.pointerHeld = false;
    this.renderQueued = false;
    this.toastTimer = null;
  }

  /** First load: parse, draw and save. */
  start() {
    this.trackPointer();
    this.refresh();
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------

  /** Re-parse, redraw and save. Call after any change to the workspace. */
  refresh() {
    this.ws.recalculate();
    this.dropMissingSelection();
    this.render();
    this.save();
  }

  /** After a workspace edit method (which already re-parsed): redraw and save. */
  refreshAfterEdit() {
    this.dropMissingSelection();
    this.render();
    this.save();
  }

  /** Redraw everything from the current workspace (no re-parse). */
  render() {
    this.renderQueued = false;
    this.rendering = true;
    const { ws } = this;

    $('#workspace-label').textContent = ws.state.example ? 'Example workspace' : 'NC workspace';
    $('#demo-banner').hidden = !ws.state.example;
    for (const channel of CHANNELS) {
      $(`#${channel}-filename`).textContent = ws.state.filenames[channel];
      $(`#${channel}-channel-badge`).textContent = `CH ${ws.state.settings[`${channel}Channel`]}`;
    }
    $('#profile-status').textContent = `4-channel machine · editing linked pair ${ws.state.settings.hChannel} + ${ws.state.settings.vChannel}`;
    $('#match-count').textContent = `${ws.alignment.matchedCount} aligned links`;
    $('#block-count').textContent = `${ws.blocks.h.length + ws.blocks.v.length} blocks`;
    $('#collapse-btn').textContent = ws.state.compact ? 'Expand' : 'Compact';

    renderBoard(this);
    if (this.ui.view === 'source') renderSourceView(this);
    renderInsights(this);
    this.updateUndoButtons();
    this.rendering = false;
  }

  /** Redraw once the mouse button is up (see constructor). */
  renderSoon() {
    this.renderQueued = true;
    setTimeout(() => this.flushQueuedRender(), 0);
  }

  flushQueuedRender() {
    if (this.renderQueued && !this.pointerHeld && !this.drag) this.render();
  }

  trackPointer() {
    document.addEventListener('pointerdown', () => { this.pointerHeld = true; }, true);
    for (const type of ['pointerup', 'pointercancel']) {
      document.addEventListener(type, () => {
        this.pointerHeld = false;
        setTimeout(() => this.flushQueuedRender(), 0);
      }, true);
    }
    window.addEventListener('blur', () => {
      this.pointerHeld = false;
      setTimeout(() => this.flushQueuedRender(), 0);
    });
  }

  updateUndoButtons() {
    $('#undo-btn').disabled = !this.ws.history.length;
    $('#redo-btn').disabled = !this.ws.future.length;
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  select(channel, id) {
    this.ui.selected = { channel, id };
    $$('.block.selected').forEach((element) => element.classList.remove('selected'));
    $$('.block.group-active').forEach((element) => element.classList.remove('group-active'));

    const element = $$('.block').find((candidate) => candidate.dataset.id === id);
    element?.classList.add('selected');
    // Light up the other parts of the same toolpath.
    if (element?.dataset.group) {
      $$('.block').filter((candidate) => candidate.dataset.group === element.dataset.group).forEach((part) => part.classList.add('group-active'));
    }
    renderSelectionDetails(this);
  }

  selectedBlock() {
    const selected = this.ui.selected;
    return selected ? this.ws.findBlock(selected.channel, selected.id) : null;
  }

  dropMissingSelection() {
    const selected = this.ui.selected;
    if (selected && !this.ws.findBlock(selected.channel, selected.id)) this.ui.selected = null;
  }

  /** Scroll to a block, select it and focus it (used by "Locate" links). */
  revealBlock(id) {
    this.setView('aligned');
    const element = $$('.block').find((candidate) => candidate.dataset.id === id);
    if (!element) return;
    this.select(element.dataset.channel, id);
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------------------
  // Editing code in place
  // ---------------------------------------------------------------------------

  /** Called while typing in a block: keep the colours and line numbers in step. */
  updateEditingBlock(textarea) {
    textarea.rows = textarea.value.split('\n').length;
    textarea.previousElementSibling.innerHTML = `${highlightNc(textarea.value)}\n`;
    const article = textarea.closest('.block');
    const block = this.ws.findBlock(article.dataset.channel, article.dataset.id);
    $('.line-numbers', article).textContent = lineNumbers(block.startLine, textarea.rows);
    $('#save-status').textContent = 'Editing…';
  }

  /** Apply the text of an edited block when the user leaves it. */
  commitEdit(textarea) {
    const article = textarea.closest('.block');
    if (!article) return;
    const channel = article.dataset.channel;
    const block = this.ws.findBlock(channel, article.dataset.id);
    if (!block || textarea.value === textarea.dataset.original) return;

    // Keep the block's original final line ending and line-ending style.
    const trailing = (block.text.match(/(?:\r\n|\n|\r)$/) || [''])[0];
    this.ws.replaceBlockText(channel, block, this.withOriginalLineEndings(textarea.value, block.text, channel) + trailing);
    delete this.ui.sourceDrafts[channel];
    this.dropMissingSelection();
    this.save();
    this.renderSoon();
  }

  /** Commit the focused block, if any (before keyboard moves, unload...). */
  commitFocusedEdit() {
    const input = document.activeElement;
    if (input?.matches('.code-input')) this.commitEdit(input);
  }

  /** Text typed in the browser uses \n; convert to the program's own line endings. */
  withOriginalLineEndings(value, original, channel) {
    const eol = (original.match(/\r\n|\r|\n/) || [this.ws.parsed[channel].eol || '\n'])[0];
    return value.replace(/\r\n|\r|\n/g, eol);
  }

  // ---------------------------------------------------------------------------
  // Views: aligned editor / full source
  // ---------------------------------------------------------------------------

  setView(next) {
    if (this.ui.view === 'source' && next !== 'source') this.applySourceDrafts();
    this.ui.view = next;
    $('#aligned-board').hidden = next !== 'aligned';
    $('#source-board').hidden = next !== 'source';
    for (const name of ['aligned', 'source']) {
      $(`#${name}-tab`).classList.toggle('active', next === name);
      $(`#${name}-tab`).setAttribute('aria-selected', String(next === name));
    }
    if (next === 'source') renderSourceView(this);
    $('#editor-hint').textContent = next === 'aligned' ? 'Drag a handle to move a block · click code to edit' : 'Apply source edits to regroup and realign';
  }

  /** Apply every channel's unapplied Source-view text. */
  applySourceDrafts() {
    const { ws, ui } = this;
    const changed = CHANNELS.filter((channel) => ui.sourceDrafts[channel] !== undefined && ui.sourceDrafts[channel] !== normalizeNewlines(ws.state.sources[channel]));
    if (changed.length) {
      const changes = Object.fromEntries(changed.map((channel) => [channel, this.withOriginalLineEndings(ui.sourceDrafts[channel], ws.state.sources[channel], channel)]));
      ws.setSources(changes);
      ui.sourceDrafts = {};
      this.refreshAfterEdit();
      return;
    }
    ui.sourceDrafts = {};
  }

  // ---------------------------------------------------------------------------
  // Undo, saving, messages
  // ---------------------------------------------------------------------------

  undo() {
    if (!this.ws.undo()) return;
    this.afterRestore();
    this.toast('Change undone');
  }

  redo() {
    if (!this.ws.redo()) return;
    this.afterRestore();
    this.toast('Change restored');
  }

  /** After the whole workspace was replaced (undo, redo, restore from file). */
  afterRestore() {
    this.ui.sourceDrafts = {};
    this.ui.selected = null;
    this.render();
    this.save();
  }

  save() {
    $('#save-status').textContent = this.ws.saveToBrowser() ? 'Saved locally' : 'Export to save';
  }

  /** Show a short message at the bottom of the screen. */
  toast(message, isError = false) {
    const element = $('#toast');
    element.textContent = message;
    element.hidden = false;
    element.classList.toggle('error', isError);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { element.hidden = true; }, TOAST_SECONDS * 1000);
  }
}

function normalizeNewlines(text) {
  return text.replace(/\r\n|\r/g, '\n');
}
