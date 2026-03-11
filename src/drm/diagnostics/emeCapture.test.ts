import { describe, it, expect, beforeEach } from "vitest";
import { EmeCapture } from "./emeCapture";

describe("EmeCapture", () => {
  let capture: EmeCapture;

  beforeEach(() => {
    capture = new EmeCapture();
  });

  it("records events with incrementing IDs", () => {
    capture.record("access-request", "ClearKey EME probe");
    capture.record("access-granted", "ClearKey EME supported");
    const events = capture.getEvents();
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe(1);
    expect(events[1].id).toBe(2);
  });

  it("computes inter-event duration correctly", () => {
    capture.record("access-request", "probe");
    // Second event should have a duration from the first
    capture.record("access-granted", "ok");
    const events = capture.getEvents();
    expect(events[1].duration).toBeTypeOf("number");
    expect(events[1].duration!).toBeGreaterThanOrEqual(0);
  });

  it("first event has no duration", () => {
    capture.record("access-request", "probe");
    expect(capture.getEvents()[0].duration).toBeUndefined();
  });

  it("clear() resets state", () => {
    capture.record("access-request", "probe");
    capture.record("access-granted", "ok");
    capture.clear();
    expect(capture.getEvents()).toHaveLength(0);

    // IDs restart after clear
    capture.record("message", "new event");
    expect(capture.getEvents()[0].id).toBe(1);
    // First event after clear has no duration
    expect(capture.getEvents()[0].duration).toBeUndefined();
  });

  it("toJSON() produces valid JSON array", () => {
    capture.record("access-request", "probe");
    capture.record("error", "failed", { success: false });
    const json = capture.toJSON();
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });

  it("getEvents() returns accumulated events", () => {
    expect(capture.getEvents()).toHaveLength(0);
    capture.record("keys-set", "configured");
    expect(capture.getEvents()).toHaveLength(1);
    expect(capture.getEvents()[0].type).toBe("keys-set");
    expect(capture.getEvents()[0].detail).toBe("configured");
  });

  it("records data and success fields when provided", () => {
    capture.record("update", "License response", {
      success: true,
      data: { sessionId: "abc123", bytes: 4096 },
    });
    const event = capture.getEvents()[0];
    expect(event.success).toBe(true);
    expect(event.data).toEqual({ sessionId: "abc123", bytes: 4096 });
  });

  it("omits data and success when not provided", () => {
    capture.record("access-request", "probe");
    const event = capture.getEvents()[0];
    expect(event.data).toBeUndefined();
    expect(event.success).toBeUndefined();
  });
});
