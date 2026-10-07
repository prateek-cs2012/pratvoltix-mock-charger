import { randomUUID } from "node:crypto";
import { Ocpp16ErrorCode } from "./actions.js";
import { OcppCallError, OcppProtocolError, OcppResponseError, OcppTimeoutError } from "./errors.js";
import {
  CALL,
  CALL_ERROR,
  CALL_RESULT,
  parseOcppMessage,
  serializeOcppMessage,
  type OcppMessage,
} from "./messages.js";
import type { OcppTransport } from "./transport.js";

/** Direction relative to this connection. The CSMS maps these onto charge-point roles. */
export type OcppFrameDirection = "inbound" | "outbound";

export type OcppObservedMessageType = "CALL" | "CALLRESULT" | "CALLERROR" | "UNKNOWN";

/** Parsed view of one frame. `payload` is the live object when parsing succeeded; observers must copy it before retaining it. */
export interface OcppObservedFrame {
  direction: OcppFrameDirection;
  messageType: OcppObservedMessageType;
  uniqueId?: string;
  action?: string;
  payload?: unknown;
  errorCode?: string;
  errorDescription?: string;
  raw: string;
}

export type OcppFrameObserver = (frame: OcppObservedFrame) => void;

export interface InboundCall {
  uniqueId: string;
  action: string;
  payload: Record<string, unknown>;
}

export interface ObservedCall<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  uniqueId: string;
  action: string;
  payload: TPayload;
  reply(payload: Record<string, unknown>): void;
  fail(errorCode: string, description: string, details?: Record<string, unknown>): void;
}

export interface OcppPeer {
  call<TResponse extends Record<string, unknown> = Record<string, unknown>>(
    action: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<TResponse>;
  waitFor<TPayload extends Record<string, unknown> = Record<string, unknown>>(
    action: string,
    timeoutMs?: number,
    predicate?: (payload: Record<string, unknown>) => boolean,
  ): Promise<ObservedCall<TPayload>>;
}

export interface OcppConnectionOptions {
  defaultTimeoutMs?: number;
  onProtocolError?: (error: Error) => void;
  onInbound?: (message: OcppMessage) => void;
}

interface PendingCall {
  action: string;
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Waiter {
  action: string;
  predicate?: (payload: Record<string, unknown>) => boolean;
  resolve: (call: ObservedCall) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class OcppConnection implements OcppPeer {
  private readonly pending = new Map<string, PendingCall>();
  private readonly waiters: Waiter[] = [];
  private readonly observers = new Set<OcppFrameObserver>();
  /** Actions for CALLs this connection sent, keyed by unique id, so a later result can be labeled. */
  private readonly sentCallActions = new Map<string, string>();
  /** Actions for CALLs this connection received and has not answered yet. */
  private readonly receivedCallActions = new Map<string, string>();
  private callHandler?: (call: InboundCall) => Promise<Record<string, unknown>> | Record<string, unknown>;
  private closed = false;

  constructor(
    private readonly transport: OcppTransport,
    private readonly options: OcppConnectionOptions = {},
  ) {
    this.transport.onMessage((raw) => {
      this.handleRaw(raw);
    });
    this.transport.onClose(() => {
      this.failAll(new Error("OCPP connection closed"));
    });
  }

  onCall(handler: (call: InboundCall) => Promise<Record<string, unknown>> | Record<string, unknown>): void {
    this.callHandler = handler;
  }

  /**
   * Subscribe to inbound and outbound frames. The returned function removes the observer.
   * Observer failures are isolated from protocol handling.
   */
  observe(observer: OcppFrameObserver): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  call<TResponse extends Record<string, unknown> = Record<string, unknown>>(
    action: string,
    payload: Record<string, unknown>,
    timeoutMs = this.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  ): Promise<TResponse> {
    if (this.closed) {
      return Promise.reject(new Error(`Cannot call ${action} on a closed connection`));
    }

    const uniqueId = randomUUID();

    return new Promise<TResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(uniqueId);
        this.sentCallActions.delete(uniqueId);
        reject(new OcppTimeoutError(action));
      }, timeoutMs);
      this.pending.set(uniqueId, {
        action,
        resolve: (value) => resolve(value as TResponse),
        reject,
        timer,
      });
      this.sendObserved([CALL, uniqueId, action, payload]);
    });
  }

  waitFor<TPayload extends Record<string, unknown> = Record<string, unknown>>(
    action: string,
    timeoutMs = this.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    predicate?: (payload: Record<string, unknown>) => boolean,
  ): Promise<ObservedCall<TPayload>> {
    if (this.closed) {
      return Promise.reject(new Error(`Cannot wait for ${action} on a closed connection`));
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        action,
        resolve: (call) => resolve(call as ObservedCall<TPayload>),
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          reject(new OcppTimeoutError(action));
        }, timeoutMs),
      };
      if (predicate) {
        waiter.predicate = predicate;
      }
      this.waiters.push(waiter);
    });
  }

  close(): void {
    this.transport.close();
    this.failAll(new Error("OCPP connection closed"));
  }

  private reply(uniqueId: string, payload: Record<string, unknown>): void {
    if (this.closed) {
      return;
    }
    this.sendObserved([CALL_RESULT, uniqueId, payload]);
  }

  private fail(uniqueId: string, errorCode: string, description: string, details: Record<string, unknown> = {}): void {
    if (this.closed) {
      return;
    }
    this.sendObserved([CALL_ERROR, uniqueId, errorCode, description, details]);
  }

  private handleRaw(raw: string): void {
    let message: OcppMessage;
    try {
      message = parseOcppMessage(raw);
    } catch (error) {
      this.emit({ direction: "inbound", messageType: "UNKNOWN", raw });
      const protocolError = error instanceof Error ? error : new OcppProtocolError("Invalid OCPP message");
      this.options.onProtocolError?.(protocolError);
      return;
    }

    this.rememberCall(message, "inbound");
    this.emit(this.toObservedFrame("inbound", message, raw));
    this.options.onInbound?.(message);

    if (message[0] === CALL) {
      void this.dispatchCall(message[1], message[2], message[3]);
      return;
    }

    if (message[0] === CALL_RESULT) {
      const pending = this.takePending(message[1]);
      pending?.resolve(message[2]);
      return;
    }

    const pending = this.takePending(message[1]);
    pending?.reject(new OcppCallError(message[2], message[3], message[4]));
  }

  private async dispatchCall(uniqueId: string, action: string, payload: Record<string, unknown>): Promise<void> {
    const waiterIndex = this.waiters.findIndex(
      (waiter) => waiter.action === action && (waiter.predicate ? waiter.predicate(payload) : true),
    );

    if (waiterIndex >= 0) {
      const waiter = this.waiters[waiterIndex];
      if (!waiter) {
        return;
      }
      this.waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      let settled = false;
      waiter.resolve({
        uniqueId,
        action,
        payload,
        reply: (response) => {
          if (settled) {
            return;
          }
          settled = true;
          this.reply(uniqueId, response);
        },
        fail: (errorCode, description, details) => {
          if (settled) {
            return;
          }
          settled = true;
          this.fail(uniqueId, errorCode, description, details);
        },
      });
      return;
    }

    if (!this.callHandler) {
      this.fail(uniqueId, Ocpp16ErrorCode.NotImplemented, `No handler for ${action}`);
      return;
    }

    try {
      const result = await this.callHandler({ uniqueId, action, payload });
      this.reply(uniqueId, result);
    } catch (error) {
      if (error instanceof OcppResponseError) {
        this.fail(uniqueId, error.errorCode, error.message, error.details);
        return;
      }
      const description = error instanceof Error ? error.message : "Call handler failed";
      this.fail(uniqueId, Ocpp16ErrorCode.InternalError, description);
    }
  }

  private sendObserved(message: OcppMessage): void {
    const raw = serializeOcppMessage(message);
    this.rememberCall(message, "outbound");
    this.emit(this.toObservedFrame("outbound", message, raw));
    this.transport.send(raw);
  }

  private rememberCall(message: OcppMessage, direction: OcppFrameDirection): void {
    if (message[0] !== CALL) {
      return;
    }
    const calls = direction === "outbound" ? this.sentCallActions : this.receivedCallActions;
    calls.set(message[1], message[2]);
  }

  private toObservedFrame(direction: OcppFrameDirection, message: OcppMessage, raw: string): OcppObservedFrame {
    if (message[0] === CALL) {
      return {
        direction,
        messageType: "CALL",
        uniqueId: message[1],
        action: message[2],
        payload: message[3],
        raw,
      };
    }

    if (message[0] === CALL_RESULT) {
      const action = this.takeCorrelatedAction(direction, message[1]);
      return {
        direction,
        messageType: "CALLRESULT",
        uniqueId: message[1],
        ...(action ? { action } : {}),
        payload: message[2],
        raw,
      };
    }

    const action = this.takeCorrelatedAction(direction, message[1]);
    return {
      direction,
      messageType: "CALLERROR",
      uniqueId: message[1],
      ...(action ? { action } : {}),
      errorCode: message[2],
      errorDescription: message[3],
      payload: message[4],
      raw,
    };
  }

  /** CALLRESULT and CALLERROR travel under the CALL's unique id. Inbound results answer calls we sent. */
  private takeCorrelatedAction(direction: OcppFrameDirection, uniqueId: string): string | undefined {
    const calls = direction === "inbound" ? this.sentCallActions : this.receivedCallActions;
    const action = calls.get(uniqueId);
    if (action !== undefined) {
      calls.delete(uniqueId);
    }
    return action;
  }

  private emit(frame: OcppObservedFrame): void {
    for (const observer of [...this.observers]) {
      try {
        observer(frame);
      } catch {
        // Diagnostic observers must not break the session.
      }
    }
  }

  private takePending(uniqueId: string): PendingCall | undefined {
    const pending = this.pending.get(uniqueId);
    if (!pending) {
      return undefined;
    }
    clearTimeout(pending.timer);
    this.pending.delete(uniqueId);
    this.sentCallActions.delete(uniqueId);
    return pending;
  }

  private failAll(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.sentCallActions.clear();
    this.receivedCallActions.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.length = 0;
  }
}
