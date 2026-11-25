/**
 * Slave↔master playback sync policy for QualityCompare ("synchronized
 * buffering").
 *
 * Pure function so the policy is unit-testable; the rAF loop in
 * QualityCompare feeds it a snapshot of both <video> elements every frame
 * and applies the returned actions in order.
 *
 * Rules:
 *  - Master stalls (seeking / buffering / Shaka rate 0) → pause the slave
 *    until the master recovers.
 *  - Slave can't show the master's frame (seeking / buffering / drift above
 *    HARD_SEEK_DRIFT) → HOLD the master (playbackRate = 0, no pause event,
 *    the same mechanism Shaka uses for its own buffering), pause the slave,
 *    seek it to the frozen master time if needed, and release both together
 *    once the slave has data there.
 *  - Small drift → nudge the slave's playbackRate ±3%.
 *  - Master claims to play (paused=false, readyState 4, rate>0) but its
 *    clock hasn't moved for MASTER_FROZEN_MS → treated as stalled. A real
 *    case: an element routed into a suspended AudioContext (autoplay
 *    policy) never advances; trusting its flags made the loop ping-pong
 *    the slave around the frozen master (slave looping a few frames).
 *
 * The previous policy hard-seeked the slave to a *moving* master target.
 * When the slave couldn't fetch+decode faster than real time (4K HEVC,
 * bandwidth below the combined bitrate) each seek landed behind the
 * master, was re-issued, flushed the buffer again and never converged:
 * the slave looped or froze while the master kept playing. Holding the
 * master makes every seek target stationary, so it converges in one seek.
 */

/** HTMLMediaElement.HAVE_FUTURE_DATA */
export const HAVE_FUTURE_DATA = 3;

/** Drift above which the slave is re-seeked (with the master held). */
export const HARD_SEEK_DRIFT = 0.2;
/** Drift below which rates are simply matched. */
export const RATE_NUDGE_DRIFT = 0.016;
/** Master clock unchanged this long while "playing" → treat as stalled. */
export const MASTER_FROZEN_MS = 300;

export interface MediaSnapshot {
  currentTime: number;
  paused: boolean;
  seeking: boolean;
  readyState: number;
  playbackRate: number;
  duration: number;
}

export interface SyncState {
  /** Master frozen (rate 0) by the sync loop, waiting for the slave. */
  masterHeld: boolean;
  /** Master's real playback rate, restored on release. */
  heldRate: number;
  /** Slave paused by the sync loop because the master stalled on its own. */
  slaveHeld: boolean;
  /** Last observed master currentTime (frozen-clock detection). */
  lastMasterTime: number;
  /** Timestamp of the previous tick (ms), NaN before the first. */
  lastTickAt: number;
  /**
   * Accumulated ms the master spent "playing" un-held without its clock
   * moving. Accumulates across our own hold/release cycles (a frozen master
   * otherwise re-triggers a hold every ~200 ms and a simple "still since"
   * timer never reaches the threshold); resets only when the clock moves or
   * the user pauses.
   */
  masterStillMs: number;
}

export type SyncAction =
  | { kind: "holdMaster" }
  | { kind: "releaseMaster"; rate: number }
  | { kind: "pauseSlave" }
  | { kind: "playSlave" }
  | { kind: "seekSlave"; time: number }
  | { kind: "setSlaveRate"; rate: number };

export function createSyncState(): SyncState {
  return { masterHeld: false, heldRate: 1, slaveHeld: false, lastMasterTime: NaN, lastTickAt: NaN, masterStillMs: 0 };
}

function slaveReady(slave: MediaSnapshot): boolean {
  return !slave.seeking && slave.readyState >= HAVE_FUTURE_DATA;
}

/** Track whether the master clock is moving; true once frozen ≥ MASTER_FROZEN_MS. */
function masterClockFrozen(master: MediaSnapshot, state: SyncState, now: number): boolean {
  const moved = master.currentTime !== state.lastMasterTime;
  const dt = Number.isNaN(state.lastTickAt) ? 0 : Math.max(0, now - state.lastTickAt);
  state.lastMasterTime = master.currentTime;
  state.lastTickAt = now;
  if (moved || master.paused || master.seeking) {
    state.masterStillMs = 0;
  } else if (master.playbackRate > 0 && !state.masterHeld) {
    // Supposed to be advancing but isn't. (While held at rate 0 by us the
    // clock is legitimately still: neither accumulate nor reset.)
    state.masterStillMs += dt;
  }
  return state.masterStillMs >= MASTER_FROZEN_MS;
}

/**
 * Decide what to do this tick. Mutates `state` to reflect the returned
 * actions. Returns an empty array when nothing needs to change.
 * `now` is a monotonic timestamp in ms (performance.now()).
 */
export function computeSyncActions(
  master: MediaSnapshot,
  slave: MediaSnapshot,
  state: SyncState,
  now: number,
): SyncAction[] {
  const masterFrozen = masterClockFrozen(master, state, now);

  // ── User paused the master ──
  // The pause handler owns the slave; just undo a hold so the master's
  // rate is correct when the user resumes.
  if (master.paused) {
    if (state.masterHeld) {
      state.masterHeld = false;
      return [{ kind: "releaseMaster", rate: state.heldRate }];
    }
    return [];
  }

  // ── Master past the end of a shorter slave ──
  if (slave.duration && master.currentTime > slave.duration) {
    const out: SyncAction[] = [];
    if (state.masterHeld) {
      state.masterHeld = false;
      out.push({ kind: "releaseMaster", rate: state.heldRate });
    }
    if (!slave.paused) out.push({ kind: "pauseSlave" });
    return out;
  }

  // ── Master held by us: wait for the slave, then release together ──
  if (state.masterHeld) {
    const out: SyncAction[] = [];
    if (master.playbackRate !== 0) {
      // Someone (user speed menu, Shaka finishing its own buffering) set a
      // rate while we hold. Adopt it as the rate to restore and re-freeze.
      state.heldRate = master.playbackRate;
      out.push({ kind: "holdMaster" });
    }
    // The master may have started seeking/buffering on its own during the
    // hold — releasing now would restore its rate while it can't play and
    // start the slave against a stalled master. Keep both parked.
    if (master.seeking || master.readyState < HAVE_FUTURE_DATA) return out;
    if (!slaveReady(slave)) return out;

    if (Math.abs(slave.currentTime - master.currentTime) > HARD_SEEK_DRIFT) {
      // Master is frozen — this target is stationary, one seek converges.
      out.push({ kind: "seekSlave", time: master.currentTime });
      return out;
    }

    if (slave.paused) {
      // Start the slave first and keep the master held until a later tick
      // observes it actually playing: if play() fails (it rejects and
      // `paused` flips back), the master must not run on alone.
      out.push({ kind: "setSlaveRate", rate: state.heldRate }, { kind: "playSlave" });
      return out;
    }

    state.masterHeld = false;
    state.slaveHeld = false;
    if (slave.playbackRate !== state.heldRate) out.push({ kind: "setSlaveRate", rate: state.heldRate });
    out.push({ kind: "releaseMaster", rate: state.heldRate });
    return out;
  }

  // ── Master stalled on its own (seeking / buffering / Shaka rate 0 /
  //    clock frozen despite "playing" flags) ──
  if (master.seeking || master.readyState < HAVE_FUTURE_DATA || master.playbackRate === 0 || masterFrozen) {
    if (!slave.paused) {
      state.slaveHeld = true;
      return [{ kind: "pauseSlave" }];
    }
    return [];
  }

  const rate = master.playbackRate;
  const drift = slave.currentTime - master.currentTime;
  const absDrift = Math.abs(drift);

  // ── Slave can't show the master's frame → hold master ──
  if (!slaveReady(slave) || absDrift > HARD_SEEK_DRIFT) {
    state.masterHeld = true;
    state.heldRate = rate;
    state.slaveHeld = false;
    const out: SyncAction[] = [{ kind: "holdMaster" }];
    if (!slave.paused) out.push({ kind: "pauseSlave" });
    if (absDrift > HARD_SEEK_DRIFT && !slave.seeking) {
      out.push({ kind: "seekSlave", time: master.currentTime });
    }
    return out;
  }

  // ── Both healthy ──
  const out: SyncAction[] = [];
  if (slave.paused) {
    // Resume after a master stall (or a missed play() on the slave).
    state.slaveHeld = false;
    out.push({ kind: "playSlave" });
  }
  let targetRate = rate;
  if (absDrift > RATE_NUDGE_DRIFT) targetRate = rate * (drift > 0 ? 0.97 : 1.03);
  if (slave.playbackRate !== targetRate) out.push({ kind: "setSlaveRate", rate: targetRate });
  return out;
}
