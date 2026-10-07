import type { OcppConnection } from "@pratvoltix/ocpp";

export interface ChargePointSession {
  identity: string;
  connection: OcppConnection;
  transactionCounter: number;
}

export type SessionListener = (identity: string, session: ChargePointSession | undefined) => void;

export class SessionRegistry {
  private readonly sessions = new Map<string, ChargePointSession>();
  private readonly locks = new Set<string>();
  private readonly listeners = new Set<SessionListener>();

  /** Synchronous: called inside replace/remove so peers can bind waiters before Boot arrives. */
  watch(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  replace(session: ChargePointSession): void {
    const existing = this.sessions.get(session.identity);
    this.sessions.set(session.identity, session);
    // Notify BEFORE closing the old socket so live peers can attach waiters on the
    // new connection before any BootNotification is dispatched.
    this.emit(session.identity, session);
    if (existing && existing.connection !== session.connection) {
      existing.connection.close();
    }
  }

  get(identity: string): ChargePointSession | undefined {
    return this.sessions.get(identity);
  }

  remove(identity: string, connection: OcppConnection): boolean {
    const current = this.sessions.get(identity);
    if (current?.connection !== connection) {
      return false;
    }
    this.sessions.delete(identity);
    this.emit(identity, undefined);
    return true;
  }

  tryLock(identity: string): boolean {
    if (this.locks.has(identity)) {
      return false;
    }
    this.locks.add(identity);
    return true;
  }

  unlock(identity: string): void {
    this.locks.delete(identity);
  }

  private emit(identity: string, session: ChargePointSession | undefined): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(identity, session);
      } catch {
        // Peer attach failures must not break OCPP accept.
      }
    }
  }
}
