import type { HeartbeatResponse } from "./types";

export interface SessionManagerOpts {
  licenseUrl: string;
  sessionToken: string;
  sessionId: string;
  renewalIntervalS: number;
  getPlaybackState: () => { position_s: number; buffer_health_s: number; rendition: string };
  onRevoked?: () => void;
}

export interface SessionManager {
  start: () => void;
  destroy: () => void;
}

/** Derive sibling endpoint URL from the license URL. */
function deriveUrl(licenseUrl: string, path: string): string {
  const url = new URL(licenseUrl);
  url.pathname = url.pathname.replace(/\/license\/?$/, path);
  return url.toString();
}

export function createSessionManager(opts: SessionManagerOpts): SessionManager {
  const { licenseUrl, sessionToken, sessionId, getPlaybackState, onRevoked } = opts;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let intervalMs = opts.renewalIntervalS * 1000;
  let stopped = false;

  const heartbeatUrl = deriveUrl(licenseUrl, "/session/heartbeat");
  const endUrl = deriveUrl(licenseUrl, "/session/end");

  async function sendHeartbeat() {
    if (stopped) return;
    const state = getPlaybackState();
    try {
      const res = await fetch(heartbeatUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          session_id: sessionId,
          position_s: state.position_s,
          buffer_health_s: state.buffer_health_s,
          rendition: state.rendition,
          timestamp: new Date().toISOString(),
        }),
      });
      if (!res.ok) {
        console.warn("[DRM] Heartbeat HTTP %d", res.status);
        return;
      }
      const data: HeartbeatResponse = await res.json();
      if (data.status === "revoke") {
        console.warn("[DRM] Session revoked by server");
        onRevoked?.();
        stop();
        return;
      }
      // Adapt interval if server requests a different cadence
      const newMs = data.next_heartbeat_s * 1000;
      if (newMs > 0 && newMs !== intervalMs) {
        intervalMs = newMs;
        if (intervalId != null) {
          clearInterval(intervalId);
          intervalId = setInterval(sendHeartbeat, intervalMs);
        }
      }
    } catch (e) {
      console.warn("[DRM] Heartbeat failed:", e);
    }
  }

  function stop() {
    stopped = true;
    if (intervalId != null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function start() {
    if (stopped) return;
    intervalId = setInterval(sendHeartbeat, intervalMs);
  }

  function destroy() {
    stop();
    const state = getPlaybackState();
    const body = JSON.stringify({
      session_id: sessionId,
      position_s: state.position_s,
      reason: "unload",
    });
    // Try sendBeacon first (survives page unload), fall back to fetch keepalive
    const sent = navigator.sendBeacon(endUrl, new Blob([body], { type: "application/json" }));
    if (!sent) {
      fetch(endUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${sessionToken}`,
        },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  }

  return { start, destroy };
}
