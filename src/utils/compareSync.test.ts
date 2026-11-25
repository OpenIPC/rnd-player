import { describe, it, expect } from "vitest";
import { computeSyncActions as compute, createSyncState, MASTER_FROZEN_MS, type MediaSnapshot, type SyncState } from "./compareSync";

const computeSyncActions = (m: MediaSnapshot, s: MediaSnapshot, st: SyncState, now = 0) => compute(m, s, st, now);

function media(over: Partial<MediaSnapshot> = {}): MediaSnapshot {
  return {
    currentTime: 100,
    paused: false,
    seeking: false,
    readyState: 4,
    playbackRate: 1,
    duration: 5000,
    ...over,
  };
}

describe("computeSyncActions", () => {
  it("does nothing when master is paused and not held", () => {
    const s = createSyncState();
    expect(computeSyncActions(media({ paused: true }), media({ currentTime: 50 }), s)).toEqual([]);
  });

  it("matches rate / nudges for small drift when both healthy", () => {
    const s = createSyncState();
    expect(computeSyncActions(media(), media(), s)).toEqual([]);
    expect(computeSyncActions(media(), media({ playbackRate: 0.97 }), s)).toEqual([{ kind: "setSlaveRate", rate: 1 }]);
    expect(computeSyncActions(media(), media({ currentTime: 100.1 }), s)).toEqual([{ kind: "setSlaveRate", rate: 0.97 }]);
    expect(computeSyncActions(media(), media({ currentTime: 99.9 }), s)).toEqual([{ kind: "setSlaveRate", rate: 1.03 }]);
  });

  it("pauses slave when master is past slave duration", () => {
    const s = createSyncState();
    expect(computeSyncActions(media({ currentTime: 120 }), media({ duration: 110 }), s)).toEqual([{ kind: "pauseSlave" }]);
  });

  describe("master stalls on its own", () => {
    it.each([
      ["buffering", { readyState: 2 }],
      ["seeking", { seeking: true }],
      ["Shaka rate 0", { playbackRate: 0 }],
    ])("pauses slave while master is %s, resumes after", (_, over) => {
      const s = createSyncState();
      expect(computeSyncActions(media(over), media({ currentTime: 100.3 }), s)).toEqual([{ kind: "pauseSlave" }]);
      expect(s.slaveHeld).toBe(true);
      // Still stalled, slave paused → nothing more (no seek-back loop)
      expect(computeSyncActions(media(over), media({ currentTime: 100.3, paused: true }), s)).toEqual([]);
      // Master recovers, slave within nudge range → resume
      const out = computeSyncActions(media(), media({ currentTime: 100.05, paused: true }), s);
      expect(out[0]).toEqual({ kind: "playSlave" });
      expect(s.slaveHeld).toBe(false);
    });
  });

  describe("slave not ready → master held (synchronized buffering)", () => {
    it("holds master while slave buffers, releases together when ready", () => {
      const s = createSyncState();
      expect(computeSyncActions(media(), media({ readyState: 2 }), s)).toEqual([
        { kind: "holdMaster" },
        { kind: "pauseSlave" },
      ]);
      expect(s.masterHeld).toBe(true);

      // Master frozen at rate 0, slave still buffering → wait
      expect(computeSyncActions(media({ playbackRate: 0 }), media({ readyState: 2, paused: true }), s)).toEqual([]);

      // Slave has data at master time → start the slave, master still held
      expect(computeSyncActions(media({ playbackRate: 0 }), media({ paused: true }), s)).toEqual([
        { kind: "setSlaveRate", rate: 1 },
        { kind: "playSlave" },
      ]);
      expect(s.masterHeld).toBe(true);
      // Slave observed playing → release the master
      expect(computeSyncActions(media({ playbackRate: 0 }), media(), s)).toEqual([{ kind: "releaseMaster", rate: 1 }]);
      expect(s.masterHeld).toBe(false);
    });

    it("large drift: holds master and seeks slave to the frozen master time exactly once", () => {
      const s = createSyncState();
      expect(computeSyncActions(media({ currentTime: 101 }), media({ currentTime: 100 }), s)).toEqual([
        { kind: "holdMaster" },
        { kind: "pauseSlave" },
        { kind: "seekSlave", time: 101 },
      ]);
      // Seek in flight → no re-seek (the old seek-storm bug)
      for (let i = 0; i < 10; i++) {
        expect(computeSyncActions(media({ currentTime: 101, playbackRate: 0 }), media({ currentTime: 101, seeking: true, readyState: 1, paused: true }), s)).toEqual([]);
      }
      // Landed → start slave, then release once it plays
      expect(computeSyncActions(media({ currentTime: 101, playbackRate: 0 }), media({ currentTime: 101, paused: true }), s)).toContainEqual({ kind: "playSlave" });
      const out = computeSyncActions(media({ currentTime: 101, playbackRate: 0 }), media({ currentTime: 101 }), s);
      expect(out.at(-1)).toEqual({ kind: "releaseMaster", rate: 1 });
    });

    it("re-seeks while held if the slave landed far from the frozen master time", () => {
      const s = createSyncState();
      computeSyncActions(media(), media({ seeking: true }), s);
      expect(s.masterHeld).toBe(true);
      expect(computeSyncActions(media({ playbackRate: 0 }), media({ currentTime: 98, paused: true }), s)).toEqual([
        { kind: "seekSlave", time: 100 },
      ]);
    });

    it("restores the user's speed (2x) on release", () => {
      const s = createSyncState();
      computeSyncActions(media({ playbackRate: 2 }), media({ readyState: 2, playbackRate: 2 }), s);
      expect(s.heldRate).toBe(2);
      computeSyncActions(media({ playbackRate: 0 }), media({ paused: true, playbackRate: 2 }), s);
      const out = computeSyncActions(media({ playbackRate: 0 }), media({ playbackRate: 2 }), s);
      expect(out).toEqual([{ kind: "releaseMaster", rate: 2 }]);
    });

    it("adopts a rate set during the hold and re-freezes the master", () => {
      const s = createSyncState();
      computeSyncActions(media(), media({ readyState: 2 }), s);
      // User picks 1.5x from the speed menu while held
      expect(computeSyncActions(media({ playbackRate: 1.5 }), media({ readyState: 2, paused: true }), s)).toEqual([
        { kind: "holdMaster" },
      ]);
      expect(s.heldRate).toBe(1.5);
    });

    it("does not release while the held master is itself seeking or buffering (review #2)", () => {
      const s = createSyncState();
      computeSyncActions(media(), media({ readyState: 2 }), s);
      expect(s.masterHeld).toBe(true);
      // Slave ready, but master started buffering / seeking during the hold
      expect(computeSyncActions(media({ playbackRate: 0, readyState: 2 }), media({ paused: true }), s)).toEqual([]);
      expect(computeSyncActions(media({ playbackRate: 0, seeking: true }), media({ paused: true }), s)).toEqual([]);
      expect(s.masterHeld).toBe(true);
      // Master ready again → proceed with release sequence
      expect(computeSyncActions(media({ playbackRate: 0 }), media({ paused: true }), s)).toContainEqual({ kind: "playSlave" });
    });

    it("keeps the master held while slave play() fails, retrying (review #4)", () => {
      const s = createSyncState();
      computeSyncActions(media(), media({ readyState: 2 }), s);
      for (let i = 0; i < 5; i++) {
        // play() rejected → slave still paused every tick
        const out = computeSyncActions(media({ playbackRate: 0 }), media({ paused: true }), s);
        expect(out).toContainEqual({ kind: "playSlave" });
        expect(out).not.toContainEqual(expect.objectContaining({ kind: "releaseMaster" }));
      }
      expect(s.masterHeld).toBe(true);
    });

    it("releases the hold if the user pauses during it", () => {
      const s = createSyncState();
      computeSyncActions(media(), media({ readyState: 2 }), s);
      expect(computeSyncActions(media({ paused: true, playbackRate: 0 }), media({ readyState: 2, paused: true }), s)).toEqual([
        { kind: "releaseMaster", rate: 1 },
      ]);
      expect(s.masterHeld).toBe(false);
    });

    it("releases the hold when master passes the end of a shorter slave", () => {
      const s = createSyncState();
      computeSyncActions(media({ currentTime: 109.9 }), media({ currentTime: 109.9, duration: 110, readyState: 2 }), s);
      expect(s.masterHeld).toBe(true);
      expect(computeSyncActions(media({ currentTime: 110.5, playbackRate: 0 }), media({ duration: 110, paused: true }), s)).toEqual([
        { kind: "releaseMaster", rate: 1 },
      ]);
    });
  });

  describe("master clock frozen despite playing flags (suspended AudioContext case)", () => {
    it("stops ping-ponging the slave and parks it until the master clock moves", () => {
      const s = createSyncState();
      const master = media({ currentTime: 2884.72 }); // paused=false, rs=4, rate=1 — but never advances
      // First tick records the baseline; the frozen timer starts on the second
      computeSyncActions(master, media({ currentTime: 2884.72 }), s, 1000);
      expect(computeSyncActions(master, media({ currentTime: 2884.75 }), s, 1100)).not.toContainEqual({ kind: "pauseSlave" });
      // Frozen for ≥ MASTER_FROZEN_MS → park slave (no hold/seek cycle)
      const out = computeSyncActions(master, media({ currentTime: 2884.8 }), s, 1100 + MASTER_FROZEN_MS);
      expect(out).toEqual([{ kind: "pauseSlave" }]);
      expect(s.masterHeld).toBe(false);
      // Still frozen, slave parked → nothing
      expect(computeSyncActions(master, media({ currentTime: 2884.8, paused: true }), s, 1600)).toEqual([]);
      // Master clock moves again → slave resumes
      const resumed = computeSyncActions(media({ currentTime: 2884.82 }), media({ currentTime: 2884.8, paused: true }), s, 1620);
      expect(resumed[0]).toEqual({ kind: "playSlave" });
    });

    it("detects a frozen master even while hold/release cycles keep firing (race seen in Chrome)", () => {
      const s = createSyncState();
      const T = 2886.64;
      let now = 0;
      let parked = false;
      // Simulate the real loop: frozen master; slave plays ahead → hold+seek → release → repeat.
      for (let cycle = 0; cycle < 5 && !parked; cycle++) {
        // ~200 ms of unheld "playing" while the slave runs 0.25 s ahead
        for (let i = 0; i < 12 && !parked; i++) {
          now += 16;
          const out = computeSyncActions(media({ currentTime: T, playbackRate: s.masterHeld ? 0 : 1 }), media({ currentTime: T + i * 0.02 }), s, now);
          if (out.length === 1 && out[0].kind === "pauseSlave" && !s.masterHeld) parked = true;
        }
        // hold, seek lands, release
        now += 16; computeSyncActions(media({ currentTime: T, playbackRate: 0 }), media({ currentTime: T, paused: true }), s, now);
      }
      expect(parked).toBe(true);
      expect(s.masterHeld).toBe(false);
    });

    it("does not flag the master while we hold it at rate 0", () => {
      const s = createSyncState();
      computeSyncActions(media(), media({ readyState: 2 }), s, 0);
      expect(s.masterHeld).toBe(true);
      for (const now of [100, 500, 1000, 2000]) {
        expect(computeSyncActions(media({ playbackRate: 0 }), media({ readyState: 2, paused: true }), s, now)).toEqual([]);
      }
    });
  });
});
