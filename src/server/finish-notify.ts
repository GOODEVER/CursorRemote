/**
 * Shared policy for "agent finished" settle timing.
 *
 * Mid-run Cursor often blips idle between tools. A long settle avoids false
 * pings; a short settle is safe only when several independent idle cues agree.
 * Keep the numeric constants in sync with `src/client/app.js`.
 */

/** Settle when idle evidence is soft (status-only / ambiguous). */
export const FINISH_SETTLE_WEAK_MS = 5000;
/** Settle when idle evidence is strong (see `isStronglyIdle`). */
export const FINISH_SETTLE_STRONG_MS = 1500;

export interface FinishIdleSignals {
  /** Composite "still working" bit (abort / live activity / busy status). */
  working: boolean;
  canAbort: boolean;
  agentActivityLive: boolean;
  agentStatus: string;
  hasQuestionnaire: boolean;
  hasApproval: boolean;
}

/**
 * True when every cheap cue says the agent is done — not blocked on the user,
 * not mid-tool, and Cursor reports a clean idle status.
 */
export function isStronglyIdle(s: FinishIdleSignals): boolean {
  if (s.working || s.canAbort || s.agentActivityLive) return false;
  if (s.hasQuestionnaire || s.hasApproval) return false;
  if (s.agentStatus !== 'idle') return false;
  return true;
}

/** Debounce window before announcing a finish for these signals. */
export function finishSettleMs(s: FinishIdleSignals): number {
  return isStronglyIdle(s) ? FINISH_SETTLE_STRONG_MS : FINISH_SETTLE_WEAK_MS;
}
