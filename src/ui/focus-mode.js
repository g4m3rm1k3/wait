/**
 * Focus mode: the side-by-side editor fills the whole screen, with the cycle
 * time, each spindle's waiting time and a thin timeline kept in view.
 * The layout itself is in styles/focus.css (body.focus-mode ...).
 */
import { $ } from './dom.js';

export function setupFocusMode() {
  $('#focus-btn').onclick = () => toggleFocusMode();
  // Leaving browser full screen (Esc, F11) also leaves focus mode.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && isFocusMode()) toggleFocusMode(false);
  });
}

export function isFocusMode() {
  return document.body.classList.contains('focus-mode');
}

/** Turn focus mode on or off (toggles when `on` is omitted). */
export function toggleFocusMode(on = !isFocusMode()) {
  document.body.classList.toggle('focus-mode', on);
  $('#focus-btn').textContent = on ? '⤡ Exit focus' : '⛶ Focus';
  // Browser full screen is a bonus; it may be refused, which is fine.
  if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  if (!on && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
