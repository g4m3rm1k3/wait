/**
 * Draws the aligned side-by-side editor and the full-source view.
 *
 * Each display row has a horizontal cell, a centre "gutter" and a vertical
 * cell. A cell is either a block (header with handles and title, then an
 * editable code area) or a dashed spacer. The gutter shows the link icon when
 * the two blocks in the row are a matched wait / macro pair.
 *
 * Code areas are a transparent <textarea> laid over a syntax-highlighted <pre>,
 * so the text stays natively editable while showing colours.
 */
import { $, $$, CHANNELS, escapeHtml, channelName, formatTime } from './dom.js';

const KIND_LABELS = { wait: 'PAIRED WAIT', 'macro-wait': 'MACRO WAIT', signal: 'SIGNAL', toolpath: 'TOOLPATH', code: 'CODE' };

/** Render the aligned board from the app's current workspace. */
export function renderBoard(app) {
  const { ws } = app;
  const board = $('#aligned-board');
  board.classList.toggle('compact', ws.state.compact);

  const rows = ws.alignment.rows.map((row) => {
    const link = ws.alignment.links.find((candidate) => candidate.aligned !== false && candidate.hId === row.h?.id && candidate.vId === row.v?.id);
    return `<div class="align-row">${cellHtml(app, row.h, 'h')}${gutterHtml(link)}${cellHtml(app, row.v, 'v')}</div>`;
  });
  const endRow = `<div class="end-row">
      <button class="end-drop" data-channel="h">Drop at end of operations</button><span></span>
      <button class="end-drop" data-channel="v">Drop at end of operations</button>
    </div>`;
  board.innerHTML = rows.join('') + endRow;

  // Set textarea values through the DOM so the exact text (including spaces) is kept.
  for (const element of $$('.block', board)) {
    const block = ws.findBlock(element.dataset.channel, element.dataset.id);
    $('.code-input', element).value = displayText(block);
  }
}

/** Fill the full-source view with both programs (or their unapplied drafts). */
export function renderSourceView(app) {
  const { ws, ui } = app;
  $('#source-board').innerHTML = CHANNELS.map((channel) => `
    <div class="source-channel">
      <div class="source-top">
        <span>${channelName(channel)} · full source${ui.sourceDrafts[channel] !== undefined ? ' · unapplied' : ''}</span>
        <button class="button small" data-apply-source="${channel}">Apply ${channel.toUpperCase()} edits</button>
      </div>
      <textarea id="source-${channel}" aria-label="${channelName(channel)} full source" spellcheck="false" wrap="off"></textarea>
    </div>`).join('');
  for (const channel of CHANNELS) $(`#source-${channel}`).value = ui.sourceDrafts[channel] ?? ws.state.sources[channel];
}

/** Block text as shown in the editor: \n line breaks and no final line break. */
export function displayText(block) {
  return block.text.replace(/(?:\r\n|\n|\r)$/, '').replace(/\r\n|\r/g, '\n');
}

/** Line-number column text for a block starting at `startLine`. */
export function lineNumbers(startLine, count) {
  return Array.from({ length: count }, (_, i) => String(startLine + i).padStart(2, ' ')).join('\n');
}

/**
 * NC syntax colouring: comments, G codes, M codes, N numbers and macro
 * words (#501, WHILE, END1...). Returns HTML.
 */
export function highlightNc(text) {
  const tokens = /\([^)]*\)|;[^\n\r]*|\b(?:WHILE|END\d*|DO\d*|NE)\b|#\d+|\bG\d+(?:\.\d+)?|\bM\d+|\bN\d+/gi;
  let html = '';
  let last = 0;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    const cssClass = /^[;(]/.test(token) ? 'comment' : /^G/i.test(token) ? 'gcode' : /^M/i.test(token) ? 'mcode' : /^N\d/i.test(token) ? 'ncode' : 'macro';
    html += escapeHtml(text.slice(last, match.index)) + `<span class="${cssClass}">${escapeHtml(token)}</span>`;
    last = match.index + token.length;
  }
  return html + escapeHtml(text.slice(last));
}

// ---------------------------------------------------------------------------

function cellHtml(app, block, channel) {
  return block ? blockHtml(app, block, channel) : `<div class="block-gap" data-channel="${channel}">alignment spacer</div>`;
}

function gutterHtml(link) {
  if (!link) return '<div class="sync-gutter"></div>';
  const isMacro = link.kind === 'macro';
  const arrow = isMacro ? (link.producer === 'v' ? '←' : '→') : '⇄';
  return `<div class="sync-gutter linked${isMacro ? ' macro' : ''}" title="${escapeHtml(link.label)}">
      <span class="sync-marker">${arrow}</span><span class="sync-label">${escapeHtml(link.label || link.key)}</span>
    </div>`;
}

function blockHtml(app, block, channel) {
  const { ws, ui } = app;
  const text = displayText(block);
  const lineCount = text.split('\n').length;
  const index = ws.blocks[channel].indexOf(block);
  const pinned = ws.isPinned(block);
  const limits = ws.movableRange(channel);
  const toolpath = block.toolpath;
  const inSplitToolpath = toolpath && toolpath.parts > 1;
  // All parts of one toolpath share a group id, used to highlight them together.
  const group = inSplitToolpath ? `${channel}:${ws.toolpathRange(channel, block).start}` : '';
  const override = ws.state.overrides[block.id];
  const label = `${channelName(channel)} block ${index + 1}: ${escapeHtml(block.title)}`;

  const classes = ['block', block.kind, `channel-${channel}`];
  if (pinned) classes.push('program-marker');
  if (ui.selected?.id === block.id) classes.push('selected');
  if (inSplitToolpath) classes.push('in-group');

  const handles = pinned
    ? '<span class="pin-marker" title="Program boundary">◇</span>'
    : `<button class="drag-handle" draggable="true" title="Drag to move within this channel" aria-label="Drag ${escapeHtml(block.title)}">⠿</button>` +
      (inSplitToolpath
        ? `<button class="drag-handle group-handle" draggable="true" title="Drag the whole toolpath ${escapeHtml(toolpath.n)} · all ${toolpath.parts} parts including its waits · Alt+Shift+↑/↓" aria-label="Drag whole toolpath ${escapeHtml(toolpath.label)}">⧉</button>`
        : '');

  const chips = [
    inSplitToolpath ? `<span class="group-chip" title="Part ${toolpath.part} of ${toolpath.parts} of ${escapeHtml(toolpath.label)}">${escapeHtml(toolpath.n)} · ${toolpath.part}/${toolpath.parts}</span>` : '',
    block.flags?.rotation ? '<span class="block-flag">B</span>' : '',
    block.flags?.toolChange ? '<span class="block-flag">TC</span>' : '',
  ].join('');

  const moveButtons = pinned
    ? ''
    : `<div class="block-moves">
        <button data-move="up" aria-label="Move block up" title="Move up · Alt+↑" ${index <= limits.start ? 'disabled' : ''}>↑</button>
        <button data-move="down" aria-label="Move block down" title="Move down · Alt+↓" ${index >= limits.end - 1 ? 'disabled' : ''}>↓</button>
      </div>`;

  const timeTitle = `Estimated block duration${override !== undefined ? ' · manual override' : ''}`;
  const duration = `<span class="block-time" title="${timeTitle}">${override !== undefined ? '~ ' : ''}${formatTime(blockDuration(ws, block.id), true)}</span>`;

  return `<article class="${classes.join(' ')}" data-id="${escapeHtml(block.id)}" data-channel="${channel}"${group ? ` data-group="${group}"` : ''} tabindex="0" aria-label="${label}">
    <div class="block-head">
      ${handles}<span class="block-title">${escapeHtml(block.title)}</span>${chips}
      <span class="block-kind">${pinned ? 'PINNED' : KIND_LABELS[block.kind] || 'CODE'}</span>${moveButtons}${duration}
    </div>
    <div class="code-wrap">
      <pre class="line-numbers" aria-hidden="true">${lineNumbers(block.startLine, lineCount)}</pre>
      <div class="code-input-wrap">
        <pre class="highlight" aria-hidden="true">${highlightNc(text)}\n</pre>
        <textarea class="code-input" rows="${lineCount}" spellcheck="false" wrap="off" aria-label="${channelName(channel)} code block ${index + 1}" data-original="${escapeHtml(text)}">${escapeHtml(text)}</textarea>
      </div>
    </div>
  </article>`;
}

/** Estimated seconds for one block, including any wait time in it. */
export function blockDuration(ws, id) {
  const item = ws.timing?.blockTimes?.[id];
  return typeof item === 'number' ? item : item?.duration;
}
