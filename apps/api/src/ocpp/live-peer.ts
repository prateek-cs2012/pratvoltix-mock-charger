import type { OcppPeer } from "@pratvoltix/ocpp";
import { OcppConnectionClosedError, OcppTimeoutError } from "@pratvoltix/ocpp";
import type { SessionRegistry } from "./registry.js";

const POLL_MS = 50;

function isClosedOrMissing(error: unknown): boolean {
  if (error instanceof OcppConnectionClosedError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message === "OCPP connection closed" ||
    error.message.startsWith("Cannot wait for ") ||
    error.message.startsWith("Cannot call ") ||
    error.message.includes("is not connected")
  );
}

/**
 * Stable OcppPeer that always uses the registry's current connection for the
 * station. waitFor survives mid-run reconnects (socket close → new session).
 */
export function createLivePeer(registry: SessionRegistry, identity: string): OcppPeer {
  const requireConnection = () => {
    const session = registry.get(identity);
    if (!session) {
      throw new Error(`${identity} is not connected`);
    }
    return session.connection;
  };

  return {
    call(action, payload, timeoutMs) {
      return requireConnection().call(action, payload, timeoutMs);
    },
    async waitFor(action, timeoutMs = 10_000, predicate) {
      const deadline = Date.now() + timeoutMs;
      let lastError: unknown;
      while (Date.now() < deadline) {
        const session = registry.get(identity);
        if (!session) {
          await sleep(POLL_MS);
          continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          break;
        }
        const slice = Math.min(remaining, 500);
        try {
          return await session.connection.waitFor(action, slice, predicate);
        } catch (error) {
          lastError = error;
          if (isClosedOrMissing(error)) {
            await sleep(POLL_MS);
            continue;
          }
          if (error instanceof OcppTimeoutError && Date.now() < deadline) {
            // Slice timeout — keep waiting (same conn or after reconnect).
            continue;
          }
          throw error;
        }
      }
      if (lastError instanceof Error) {
        throw lastError;
      }
      throw new Error(`Timed out waiting for ${action}`);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
