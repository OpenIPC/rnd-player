export type EmeEventType =
  | "access-request" | "access-granted" | "access-denied"
  | "keys-created" | "keys-set" | "generate-request"
  | "message" | "update" | "key-status-change"
  | "close" | "expiration-change" | "error";

export interface EmeEvent {
  id: number;
  timestamp: number;
  type: EmeEventType;
  detail: string;
  data?: unknown;
  duration?: number;
  success?: boolean;
}

export type EmeEventCallback = (
  type: EmeEventType,
  detail: string,
  opts?: { data?: unknown; success?: boolean },
) => void;

export class EmeCapture {
  private events: EmeEvent[] = [];
  private nextId = 1;

  record(type: EmeEventType, detail: string, opts?: { data?: unknown; success?: boolean }): void {
    const timestamp = performance.now();
    const prev = this.events.length > 0 ? this.events[this.events.length - 1] : null;
    const duration = prev ? timestamp - prev.timestamp : undefined;

    this.events.push({
      id: this.nextId++,
      timestamp,
      type,
      detail,
      data: opts?.data,
      duration,
      success: opts?.success,
    });
  }

  getEvents(): readonly EmeEvent[] {
    return this.events;
  }

  clear(): void {
    this.events = [];
    this.nextId = 1;
  }

  toJSON(): string {
    return JSON.stringify(this.events, null, 2);
  }
}
