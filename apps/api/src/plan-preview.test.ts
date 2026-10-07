import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { SessionRegistry } from "./ocpp/registry.js";
import { SimulatorRegistry } from "./simulator/registry.js";

describe("POST /api/run-plans/resolve", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it("previews a plan without creating a run or taking a lock", async () => {
    const sessions = new SessionRegistry();
    sessions.replace({
      identity: "CP001",
      connection: { close() { /* unused */ } } as never,
      transactionCounter: 0,
    });
    const listened = await listen(sessions);
    server = listened.server;
    const base = listened.base;
    const accepted = await post(base, {
      chargePointIdentity: "CP001",
      selection: { suiteIds: ["smoke"] },
      overrides: { idTag: "LAB-CARD-002" },
    });
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as {
      station: { connected: boolean; capabilities: string[] };
      plan: { cases: Array<{ id: string }> };
      effectiveProfile: { name: string; parameters: { idTag: string }; overridden: string[] };
      compatibility: { compatible: boolean };
      estimatedTimeoutMs: number;
    };
    expect(body.plan.cases.map((testCase) => testCase.id)).toEqual(["boot-notification", "heartbeat", "status-notification"]);
    expect(body.effectiveProfile.name).toBe("default-ocpp16");
    expect(body.effectiveProfile.parameters.idTag).toBe("LAB-CARD-002");
    expect(body.effectiveProfile.overridden).toEqual(["idTag"]);
    expect(body.station.connected).toBe(true);
    expect(body.compatibility.compatible).toBe(true);
    expect(body.estimatedTimeoutMs).toBeGreaterThan(0);
    expect(sessions.tryLock("CP001")).toBe(true);

    const negative = await post(base, { chargePointIdentity: "CP009", selection: { suiteIds: ["simulator-negative"] } });
    expect(negative.status).toBe(200);
    const missing = (await negative.json()) as { station: { connected: boolean }; compatibility: { compatible: boolean; missingCapabilities: Array<{ capability: string }> } };
    expect(missing.station.connected).toBe(false);
    expect(missing.compatibility.compatible).toBe(false);
    expect(missing.compatibility.missingCapabilities[0]?.capability).toBe("simulator-control");

    const invalid = await post(base, {
      chargePointIdentity: "CP001",
      selection: { suiteIds: ["smoke"] },
      profile: { schemaVersion: "9", parameters: {} },
    });
    expect(invalid.status).toBe(400);
  });
});

async function listen(sessions: SessionRegistry): Promise<{ base: string; server: Server }> {
  const app = createApp(sessions, new SimulatorRegistry());
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${address.port}`, server };
}

function post(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/run-plans/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
