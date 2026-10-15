/** Small DOM and formatting helpers used across the UI. */

export const CHANNELS = ['h', 'v'];

/** First element matching `selector`. */
export const $ = (selector, root = document) => root.querySelector(selector);

/** All elements matching `selector`, as an array. */
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Make text safe to put inside HTML. */
export function escapeHtml(value) {
  const replacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, (char) => replacements[char]);
}

export function channelName(channel) {
  return channel === 'h' ? 'Horizontal' : 'Vertical';
}

/**
 * Seconds as "m:ss". With `precise`, times under a minute show as "4.2s" / "12s".
 * Non-numbers show as "—".
 */
export function formatTime(seconds, precise = false) {
  if (!Number.isFinite(Number(seconds))) return '—';
  seconds = Math.max(0, Number(seconds));
  if (precise && seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}

/** Make the browser download `content` as a file named `name`. */
export function downloadFile(content, name, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
