/**
 * Collects timing diagnostics and whether the estimate is complete.
 *
 * `complete` turns false whenever some time could not be modeled (an arc, a
 * G68, a stalled wait...). The UI then shows the cycle time as partial.
 */
export class TimingReport {
  constructor() {
    this.diagnostics = [];
    this.complete = true;
    this.seen = new Set(); // identical notes are reported once
  }

  /** Add a note: level is 'info' | 'warning' | 'error'. */
  warn(code, message, blockIds = [], level = 'warning') {
    const key = `${code}:${blockIds.join(',')}:${message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.diagnostics.push({ level, code, message, ...(blockIds.length ? { blockIds } : {}) });
  }

  markIncomplete() {
    this.complete = false;
  }
}
