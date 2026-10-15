/**
 * The right-hand "Cycle insights" panel and the Focus-mode readout:
 * cycle time, timeline, cutting coverage, per-spindle totals, the selected
 * block's details, and review notes (diagnostics from all three stages).
 */
import { $, CHANNELS, escapeHtml, channelName, formatTime } from './dom.js';
import { blockDuration } from './board.js';

export function renderInsights(app) {
  const { timing } = app.ws;
  const stalled = timing.diagnostics.some((note) => note.code === 'synchronization-stalled' || note.code === 'schedule-limit');

  $('#cycle-time').textContent = `~ ${formatTime(timing.duration)}`;
  $('#cycle-note').textContent = stalled
    ? 'Schedule stalled · totals stop at the blockage'
    : timing.complete
      ? 'Estimated schedule · selected pair only'
      : 'Partial estimate · review unresolved timing';
  $('#timeline-scale').textContent = `0 — ${formatTime(timing.duration)}`;

  // The same timeline appears in the panel and above the editor in Focus mode.
  $('#timeline').innerHTML = $('#focus-timeline').innerHTML = timelineHtml(timing);
  $('#focus-stats').innerHTML = focusStatsHtml(timing);
  $('#cut-coverage').innerHTML = coverageHtml(timing, stalled);
  $('#utilization').innerHTML = CHANNELS.map((channel) => utilizationHtml(channel, timing.channels[channel])).join('');
  renderReviewNotes(app);
  renderSelectionDetails(app);
}

/** Details and manual-time controls for the selected block. */
export function renderSelectionDetails(app) {
  const { ws, ui } = app;
  const panel = $('#selection-details');
  const block = ui.selected && ws.findBlock(ui.selected.channel, ui.selected.id);
  if (!block) {
    panel.innerHTML = '<div class="section-label">BLOCK DETAILS</div><div class="empty-selection">Select a block to inspect its time or set a duration.</div>';
    return;
  }

  const manual = ws.state.overrides[block.id];
  const header = `
    <div class="section-label">BLOCK DETAILS <span>${channelName(ui.selected.channel).toUpperCase()}</span></div>
    <h3 class="selection-title">${escapeHtml(block.title)}</h3>
    <div class="selection-meta">
      Lines ${block.startLine}–${block.endLine} · ${escapeHtml(block.kind)}<br>
      Estimated ${formatTime(blockDuration(ws, block.id), true)}${block.sync ? `<br>${escapeHtml(block.sync.key)} · ${escapeHtml(block.sync.role)}` : ''}
    </div>`;

  let controls;
  if (block.sync) {
    controls = '<p class="field-hint">Sync time is calculated from when each channel reaches this point.</p>';
  } else if (ws.isPinned(block)) {
    controls = '<p class="field-hint">Program boundary is pinned. Edit its code in place or in Source view.</p>';
  } else {
    controls = `
      <label class="override-label" for="duration-override">Duration override
        <input id="duration-override" type="number" min="0" step="0.1" placeholder="auto" value="${manual ?? ''}" aria-label="Block duration override in seconds"> sec
      </label>
      <button id="apply-duration" class="button small duration-apply">Apply duration</button>
      ${manual !== undefined ? '<button id="reset-duration" class="override-reset">Use calculated time</button>' : ''}
      <p class="field-hint" style="font-size:9px;margin-bottom:0">Enter seconds, then Apply or press Enter.</p>
      <button id="delete-block" class="delete-block">Remove selected block</button>`;
  }
  panel.innerHTML = header + controls;
}

// ---------------------------------------------------------------------------

function timelineHtml(timing) {
  const scale = Math.max(1, timing.duration);
  return CHANNELS.map((channel) => {
    const segments = (timing.segments[channel] || []).map((segment) => {
      const left = (100 * segment.start) / scale;
      const width = (100 * (segment.end - segment.start)) / scale;
      const tip = `${segment.label || segment.type} · ${formatTime(segment.end - segment.start, true)} (${formatTime(segment.start)}–${formatTime(segment.end)})`;
      return `<span class="timeline-segment ${escapeHtml(segment.type)}" style="left:${left}%;width:${width}%" title="${escapeHtml(tip)}"></span>`;
    });
    return `<div class="timeline-lane"><span>${channel.toUpperCase()}</span><div class="timeline-bar" aria-label="${channelName(channel)} estimated timeline">${segments.join('')}</div></div>`;
  }).join('');
}

/**
 * Focus-mode readout. The spindle that waits least is the one setting the
 * cycle time, so it is highlighted: that is the one to keep busy.
 */
function focusStatsHtml(timing) {
  const waits = { h: timing.channels.h.wait || 0, v: timing.channels.v.wait || 0 };
  const bottleneck = waits.h <= waits.v ? 'h' : 'v';
  const partialMark = timing.complete ? '' : '*';
  const channelStats = CHANNELS.map((channel) => {
    const isBottleneck = channel === bottleneck;
    return `<span class="${isBottleneck ? 'bottleneck' : ''}" title="${isBottleneck ? 'Waits least · sets the cycle' : ''}">${channel.toUpperCase()} wait <b>${formatTime(waits[channel])}</b></span>`;
  }).join('');
  const cutting = timing.coverage ? `<span>Cutting <b>${Math.round(100 * timing.coverage.utilization)}%</b></span>` : '';
  return `<span class="${timing.complete ? '' : 'partial'}">Cycle <b>~${formatTime(timing.duration)}${partialMark}</b></span>${channelStats}${cutting}`;
}

function coverageHtml(timing, stalled) {
  const coverage = timing.coverage;
  if (!coverage) return '';
  const percent = Math.round(100 * coverage.utilization);
  const partialNote = timing.complete
    ? ''
    : `<p class="partial-note">* ${stalled ? 'Until the blockage; remaining operations excluded.' : 'Partial modeled time; unresolved operations excluded.'}</p>`;
  return `
    <div class="section-label">AT LEAST ONE CUTTING <strong>${percent}%${timing.complete ? '' : '*'}</strong></div>
    <div class="coverage-bar"><span style="width:${100 * coverage.utilization}%"></span></div>
    <div class="coverage-detail"><span>Neither channel cutting</span><strong>${formatTime(coverage.nonCutting)}</strong></div>
    ${partialNote}`;
}

function utilizationHtml(channel, stats) {
  const percent = Math.min(100, Math.max(0, (stats.utilization || 0) * 100));
  const rows = [['Cut time', stats.cut], ['Air time', stats.air], ['Tool change', stats.toolChange], ['Waiting', stats.wait]]
    .map(([name, seconds]) => `<div class="util-stat"><span>${name}</span><strong>${formatTime(seconds)}</strong></div>`)
    .join('');
  return `
    <div class="util-card ${channel}">
      <div class="util-title" title="Estimated cutting utilization = feed-motion time / linked cycle time">
        <i class="legend-dot ${channel === 'h' ? 'mint' : 'violet'}"></i>${channelName(channel)}<strong>${Math.round(percent)}<small style="font-size:10px">%</small></strong>
      </div>
      <div class="util-bar" title="Estimated feed-motion utilization"><div class="util-fill" style="width:${percent}%"></div></div>
      <div class="util-grid">${rows}</div>
    </div>`;
}

/** Notes from the parser (per channel), the alignment and the timing, without duplicates. */
function renderReviewNotes(app) {
  const { ws } = app;
  const parserNotes = CHANNELS.flatMap((channel) => (ws.parsed[channel].diagnostics || []).map((note) => ({ ...note, message: `${channel.toUpperCase()}: ${note.message}` })));
  const all = [...parserNotes, ...(ws.alignment.diagnostics || []), ...(ws.timing.diagnostics || [])];
  const unique = [...new Map(all.map((note) => [`${note.code}|${note.message}`, note])).values()];

  $('#diagnostic-count').textContent = unique.length;
  $('#diagnostics').innerHTML = unique.length
    ? unique.map((note) => {
      const level = escapeHtml(note.level || note.severity || 'info');
      const locate = note.blockIds?.length ? ` <a href="#" data-find-block="${escapeHtml(note.blockIds[0])}">Locate</a>` : '';
      return `<div class="diagnostic-item ${level}">${escapeHtml(note.message)}${locate}</div>`;
    }).join('')
    : '<div class="diagnostic-item">No synchronization conflicts found in the recognized code.</div>';
}
