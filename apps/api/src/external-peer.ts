import { parseOcppMessage, type OcppObservedFrame, type OcppPeer, type ObservedCall } from "@pratvoltix/ocpp";

export interface MirroredFrame {
  direction: "charge-point-to-csms" | "csms-to-charge-point";
  raw: string;
}

type Waiter = {
  action: string;
  predicate?: (payload: Record<string, unknown>) => boolean;
  resolve: (call: ObservedCall) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class ExternalOcppSession implements OcppPeer {
  private readonly observers = new Set<(frame: OcppObservedFrame) => void>();
  private readonly buffered: ObservedCall[] = [];
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly emit: (action: string, connectorId?: number) => Promise<{ status: "Accepted" }>,
  ) {}

  observe(observer: (frame: OcppObservedFrame) => void): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  ingest(frame: MirroredFrame): boolean {
    const observed = toObservedFrame(frame);
    if (!observed) {
      return false;
    }
    for (const observer of this.observers) {
      observer(observed);
    }
    if (observed.direction === "inbound" && observed.messageType === "CALL" && observed.action && isRecord(observed.payload)) {
      this.deliver({
        uniqueId: observed.uniqueId ?? "",
        action: observed.action,
        payload: observed.payload,
        reply: () => undefined,
        fail: () => undefined,
      });
    }
    return true;
  }

  async call<TResponse extends Record<string, unknown> = Record<string, unknown>>(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<TResponse> {
    if (action !== "TriggerMessage") {
      throw new Error("External mode only drives charger-originated TriggerMessage.");
    }
    const requested = payload["requestedMessage"];
    if (typeof requested !== "string" || requested.length === 0) {
      throw new Error("TriggerMessage requires requestedMessage.");
    }
    const connectorId = typeof payload["connectorId"] === "number" ? payload["connectorId"] : undefined;
    const result = await this.emit(requested, connectorId);
    return result as unknown as TResponse;
  }

  waitFor<TPayload extends Record<string, unknown> = Record<string, unknown>>(
    action: string,
    timeoutMs = 15_000,
    predicate?: (payload: Record<string, unknown>) => boolean,
  ): Promise<ObservedCall<TPayload>> {
    const index = this.buffered.findIndex((call) => call.action === action && (predicate?.(call.payload) ?? true));
    if (index >= 0) {
      const [match] = this.buffered.splice(index, 1);
      return Promise.resolve(match as ObservedCall<TPayload>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const position = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (position >= 0) {
          this.waiters.splice(position, 1);
        }
        reject(new Error(`Timed out waiting for ${action}`));
      }, timeoutMs);
      this.waiters.push({
        action,
        ...(predicate ? { predicate } : {}),
        resolve: (call) => resolve(call as ObservedCall<TPayload>),
        reject,
        timer,
      });
    });
  }

  private deliver(call: ObservedCall): void {
    const index = this.waiters.findIndex((waiter) => waiter.action === call.action && (waiter.predicate?.(call.payload) ?? true));
    if (index < 0) {
      this.buffered.push(call);
      return;
    }
    const [waiter] = this.waiters.splice(index, 1);
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(call);
  }
}

export function toObservedFrame(frame: MirroredFrame): OcppObservedFrame | undefined {
  if (isControlEnvelope(frame.raw)) {
    return undefined;
  }
  const direction = frame.direction === "charge-point-to-csms" ? "inbound" : "outbound";
  try {
    const message = parseOcppMessage(frame.raw);
    if (message[0] === 2) {
      return {
        direction,
        messageType: "CALL",
        uniqueId: message[1],
        action: message[2],
        payload: message[3],
        raw: frame.raw,
      };
    }
    if (message[0] === 3) {
      return {
        direction,
        messageType: "CALLRESULT",
        uniqueId: message[1],
        payload: message[2],
        raw: frame.raw,
      };
    }
    return {
      direction,
      messageType: "CALLERROR",
      uniqueId: message[1],
      errorCode: message[2],
      errorDescription: message[3],
      payload: message[4],
      raw: frame.raw,
    };
  } catch {
    return { direction, messageType: "UNKNOWN", raw: frame.raw };
  }
}

function isControlEnvelope(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return false;
    }
    return (parsed["type"] === "request" || parsed["type"] === "response") && typeof parsed["requestId"] === "string";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
