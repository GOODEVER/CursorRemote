/**
 * Cheap in-page fingerprint used to skip a full DOM extraction when nothing
 * meaningful changed. Must stay tiny: it runs every poll instead of (or before)
 * the multi-KB extractionFunction.
 *
 * Completely self-contained — serialized into Cursor via Runtime.evaluate.
 */

export interface ExtractFingerprint {
  /** Stable compare key. */
  key: string;
  /** True when the agent still looks busy (abort/loading/shimmer). */
  working: boolean;
}

/**
 * Runs inside Cursor's renderer. Returns null when no chat container is mounted
 * (same meaning as a null full extraction).
 */
export function extractionFingerprintFunction(containerSelectors: string[]): ExtractFingerprint | null {
  let container: Element | null = null;
  for (const sel of containerSelectors) {
    try {
      container = document.querySelector(sel);
      if (container) break;
    } catch {
      /* invalid selector */
    }
  }
  if (!container) return null;

  const wrappers = container.querySelectorAll(
    '[data-flat-index], [data-message-index], .composer-rendered-message[data-message-role], [data-message-role][data-message-id]'
  );
  const n = wrappers.length;
  let lastId = '';
  let lastLen = 0;
  let lastRole = '';
  if (n > 0) {
    const last = wrappers[n - 1] as Element;
    const msgEl = last.querySelector('[data-message-role]') || last;
    lastId = msgEl.getAttribute('data-message-id')
      || last.getAttribute('data-flat-index')
      || last.getAttribute('data-message-index')
      || '';
    lastRole = msgEl.getAttribute('data-message-role') || '';
    // textContent length tracks streaming growth without shipping HTML.
    lastLen = (msgEl.textContent || '').length;
  }

  const isVisible = (el: Element | null): boolean => {
    if (!el) return false;
    const h = el as HTMLElement;
    if (h.offsetParent === null && getComputedStyle(h).position !== 'fixed') return false;
    return h.getClientRects().length > 0;
  };

  const hasLoading = container.querySelector('.loading-indicator-v3') !== null;
  const canAbort =
    isVisible(container.querySelector('.ui-shell-tool-call__glass-stop')) ||
    isVisible(document.querySelector('.ui-shell-tool-call__glass-stop')) ||
    isVisible(document.querySelector('button[aria-label="Stop generation"]')) ||
    isVisible(document.querySelector('.ui-prompt-input-submit-button[aria-label*="Stop" i]')) ||
    isVisible(document.querySelector('.ui-prompt-input-submit-button[aria-label*="Cancel" i]')) ||
    hasLoading;

  // First shimmer / shine label — catches "Thinking…" without a full walk.
  let shine = '';
  const shineEl = container.querySelector('.make-shine');
  if (shineEl) shine = (shineEl.textContent || '').trim().slice(0, 48);

  const approvals = container.querySelectorAll(
    '[data-click-ready], .composer-tool-call-approval, .ui-shell-tool-call__actions button'
  ).length;

  let questionnaire = '';
  const q = container.querySelector('.glass-questionnaire-tray, [class*="questionnaire"]');
  if (q) questionnaire = (q.textContent || '').trim().slice(0, 32);

  const composer =
    container.getAttribute('data-composer-id')
    || document.querySelector('[data-composer-id]')?.getAttribute('data-composer-id')
    || '';

  const tabs = document.querySelectorAll(
    '[data-composer-id].composer-tab, .composer-tab-container [data-composer-id]'
  ).length;

  const working = canAbort || hasLoading || shine.length > 0;
  const key = [
    composer,
    n,
    lastId,
    lastRole,
    lastLen,
    canAbort ? 1 : 0,
    hasLoading ? 1 : 0,
    shine,
    approvals,
    questionnaire,
    tabs,
  ].join('|');

  return { key, working };
}
