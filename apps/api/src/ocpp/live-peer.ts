import type { ObservedCall, OcppConnection, OcppPeer } from "@pratvoltix/ocpp";
import { OcppConnectionClosedError, OcppTimeoutError } from "@pratvoltix/ocpp";
import type { ChargePointSession, SessionRegistry } from "./registry.js";

type PendingWaiter = {
  action: string;
  predicate?: (payload: Record<string, unknown>) => boolean;
  deadline: number;
  resolve: (call: ObservedCall) => void;
  reject: (error: Error) => void;
  bindId: number;
  boundConnection?: OcppConnection;
  settled: boolean;
};

function isClosedError(error: unknown): boolean {
  if (error instanceof OcppConnectionClosedError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message === "OCPP connection closed" ||
    error.message.startsWith("Cannot wait for ") ||
    error.message.startsWith("Cannot call ")
  );
}

/**
 * Stable OcppPeer for embedded catalog runs. Pending waitFor calls are rebound
 * synchronously when SessionRegistry.replace() notifies, so BootNotification
 * after Soft Reset / disconnect is not lost to the default callHandler.
 */
export function createLivePeer(registry: SessionRegistry, identity: string): OcppPeer {
  const pending: PendingWaiter[] = [];
  let nextBindId = 1;

  registry.watch((id, session) => {
    if (id !== identity || !session) {
      return;
    }
    rebindAll(session);
  });

  function settle(waiter: PendingWaiter, fn: () => void): void {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;
    const index = pending.indexOf(waiter);
    if (index >= 0) {
      pending.splice(index, 1);
    }
    fn();
  }

  function bindWaiter(waiter: PendingWaiter, session: ChargePointSession): void {
    if (waiter.settled) {
      return;
    }
    if (waiter.boundConnection === session.connection) {
      return;
    }

    const remaining = waiter.deadline - Date.now();
    if (remaining <= 0) {
      settle(waiter, () => waiter.reject(new OcppTimeoutError(waiter.action)));
      return;
    }

    const bindId = nextBindId++;
    waiter.bindId = bindId;
    waiter.boundConnection = session.connection;

    void session.connection
      .waitFor(waiter.action, remaining, waiter.predicate)
      .then((call) => {
        if (waiter.bindId !== bindId || waiter.settled) {
          // Claimed by a superseded bind — still answer so the CP is not left hanging.
          try {
            if (call.action === "BootNotification") {
              call.reply({
                status: "Accepted",
                currentTime: new Date().toISOString(),
                interval: 300,
              });
            } else {
              call.reply({});
            }
          } catch {
            // ignore
          }
          return;
        }
        settle(waiter, () => waiter.resolve(call));
      })
      .catch((error: unknown) => {
        if (waiter.bindId !== bindId || waiter.settled) {
          return;
        }
        if (isClosedError(error)) {
          waiter.boundConnection = undefined;
          // Soft Reset / disconnect: keep waiter pending until replace() rebinds.
          return;
        }
        if (error instanceof OcppTimeoutError) {
          settle(waiter, () => waiter.reject(error));
          return;
        }
        settle(waiter, () =>
          waiter.reject(error instanceof Error ? error : new Error(String(error))),
        );
      });
  }

  function rebindAll(session: ChargePointSession): void {
    for (const waiter of [...pending]) {
      bindWaiter(waiter, session);
    }
  }

  return {
    call(action, payload, timeoutMs) {
      const session = registry.get(identity);
      if (!session) {
        return Promise.reject(new Error(`${identity} is not connected`));
      }
      return session.connection.call(action, payload, timeoutMs);
    },

    waitFor<TPayload extends Record<string, unknown> = Record<string, unknown>>(
      action: string,
      timeoutMs = 10_000,
      predicate?: (payload: Record<string, unknown>) => boolean,
    ): Promise<ObservedCall<TPayload>> {
      return new Promise<ObservedCall<TPayload>>((resolve, reject) => {
        const waiter: PendingWaiter = {
          action,
          ...(predicate ? { predicate } : {}),
          deadline: Date.now() + timeoutMs,
          resolve: (call) => resolve(call as ObservedCall<TPayload>),
          reject,
          bindId: 0,
          settled: false,
        };
        pending.push(waiter);

        const session = registry.get(identity);
        if (session) {
          bindWaiter(waiter, session);
        }
      });
    },
  };
}
