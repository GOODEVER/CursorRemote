/**
 * Idle-aware poll pacing.
 *
 * The extractor used to re-read Cursor's DOM on a fixed interval forever, even
 * when nothing was happening. An idle agent is the common steady state, so that
 * is wasted work: a full CDP round trip plus a DOM walk, every tick, all day.
 *
 * The policy below slows the cadence once the DOM has genuinely settled (no
 * content change for a few quiet ticks) and snaps back to the base rate the
 * moment anything moves — a content change, a command from the phone, or a
 * reconnect. Idle is only ever "last N polls returned the same signature AND
 * the agent does not claim to be working", so active work keeps full-speed
 * polling and the UI never feels laggy after a real event.
 */

/** How many consecutive unchanged, non-working polls before slowing down. */
export const QUIET_TICKS_BEFORE_IDLE = 3;

export interface PollPacingState {
  /** Consecutive polls with an unchanged content signature and no work claimed. */
  quietTicks: number;
  /** True while the interval is the slower idle cadence. */
  idle: boolean;
}

/** Fresh pacing state — starts at full speed so startup is never throttled. */
export function createPollPacing(): PollPacingState {
  return { quietTicks: 0, idle: false };
}

/**
 * Cheap signature of everything that should reset the idle cadence.
 *
 * Deliberately small — it must stay far cheaper than the transcript it guards,
 * so it keys off counts/ids/status rather than serializing message bodies. The
 * volatile bookkeeping the extractor owns (`lastExtractionAt`, failure
 * counters) is excluded: it changes every poll and would defeat the backoff.
 */
export function pollContentKey(state: {
  agentStatus: string;
  agentActivityText: string | null;
  canAbort: boolean;
  messages: { id: string; type: string }[];
  pendingApprovals: { id: string }[];
  questionnaire: { totalLabel: string; activeIndex: number } | null;
  composerQueue: { items: unknown[] };  chatTabs: unknown[];
  folders?: unknown[];
  slashCommands?: unknown[];
  mode: { current: string };
  model: { current: string };
  activeComposerId: string;
  activeWindowId: string;
}): string {
  const last = state.messages.length > 0 ? state.messages[state.messages.length - 1] : null;
  return [
    state.agentStatus,
    state.agentActivityText ?? '',
    state.canAbort ? 1 : 0,
    state.messages.length,
    last ? `${last.type}:${last.id}` : '',
    state.pendingApprovals.length,
    state.questionnaire ? `${state.questionnaire.totalLabel}/${state.questionnaire.activeIndex}` : '',
    state.composerQueue?.items?.length ?? 0,
    state.chatTabs.length,
    state.folders?.length ?? 0,
    state.slashCommands?.length ?? 0,
    state.mode?.current ?? '',
    state.model?.current ?? '',
    state.activeComposerId,
    state.activeWindowId,
  ].join('|');
}

export interface PollPacingInput {
  /** Whether this poll's content signature matched the previous poll's. */
  unchanged: boolean;
  /** Whether the state still claims the agent is actively working. */
  working: boolean;
}

/**
 * Fold one poll result into the pacing state and return the interval to wait
 * before the next poll.
 *
 * @param state        Mutable pacing state (updated in place).
 * @param input        What this poll observed.
 * @param baseInterval Full-speed interval; also the ceiling of the idle value.
 * @param idleInterval Desired idle interval. `<= baseInterval` disables backoff.
 */
export function nextPollInterval(
  state: PollPacingState,
  input: PollPacingInput,
  baseInterval: number,
  idleInterval: number
): number {
  const idleAllowed = idleInterval > baseInterval;

  if (input.unchanged && !input.working) {
    state.quietTicks += 1;
    if (idleAllowed && state.quietTicks >= QUIET_TICKS_BEFORE_IDLE) {
      state.idle = true;
      return idleInterval;
    }
    return baseInterval;
  }

  // Anything moved, or the agent is working: back to full speed immediately.
  state.quietTicks = 0;
  state.idle = false;
  return baseInterval;
}
