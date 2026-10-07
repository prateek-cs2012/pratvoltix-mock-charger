import type { OcppConnection } from "@pratvoltix/ocpp";

export interface ChargePointSession {
  identity: string;
  connection: OcppConnection;
  transactionCounter: number;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, ChargePointSession>();
  private readonly locks = new Set<string>();

  replace(session: ChargePointSession): void {
    const existing = this.sessions.get(session.identity);
    this.sessions.set(session.identity, session);
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
}
