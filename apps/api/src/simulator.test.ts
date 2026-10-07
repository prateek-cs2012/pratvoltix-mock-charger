import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OcppConnection } from "@pratvoltix/ocpp";
import { CONTROL_PROTOCOL_VERSION, CONTROL_SUBPROTOCOL, ControlChannel, SIMULATOR_CAPABILITY, validateFaultRule, validateHello } from "@pratvoltix/simulator-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createApp } from "./app.js";
import { SessionRegistry } from "./ocpp/registry.js";
import { attachOcppServer } from "./ocpp/server.js";
import { SimulatorRegistry } from "./simulator/registry.js";
import { attachSimulatorControl } from "./simulator/server.js";

const create = vi.hoisted(() => vi.fn());

vi.mock("./models/test-run.js", () => ({
  TestRunModel: {
    create,
    findById: vi.fn(async () => null),
    findByIdAndUpdate: vi.fn(async () => null),
  },
}));

describe("simulator control API", () => {
  let server: Server | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    create.mockReset();
    for (const socket of sockets) {
      socket.close();
    }
    sockets.length = 0;
    if (!server) {
      return;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it("lists and shows a connected simulator without fault payloads", async () => {
    const simulators = new SimulatorRegistry();
    const base = await listen(new SessionRegistry(), simulators);
    const socket = await hello(base, "CP001");
    sockets.push(socket);
    const listed = await fetch(`${base}/api/simulators`).then(async (response) => response.json());
    expect(listed).toEqual([
      expect.objectContaining({
        identity: "CP001",
        connected: true,
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        capabilities: [SIMULATOR_CAPABILITY],
        activeFaults: [],
      }),
    ]);
    const shown = await fetch(`${base}/api/simulators/CP001`).then(async (response) => response.json());
    expect(shown.simulatorName).toBe("Pratvoltix Mock");
    expect(JSON.stringify(shown)).not.toContain("payload");
    const missing = await fetch(`${base}/api/simulators/CP999`);
    expect(missing.status).toBe(404);
    socket.close();
  });

  it("replaces a duplicate simulator identity", async () => {
    const simulators = new SimulatorRegistry();
    const base = await listen(new SessionRegistry(), simulators);
    const first = await hello(base, "CP001");
    sockets.push(first);
    let closed = false;
    first.on("close", () => {
      closed = true;
    });
    const second = await hello(base, "CP001");
    sockets.push(second);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(true);
    expect(simulators.list()).toHaveLength(1);
    expect(simulators.get("CP001")?.connected).toBe(true);
    second.close();
  });

  it("rejects a simulator-dependent run before it is queued and still accepts an ordinary plan", async () => {
    const sessions = new SessionRegistry();
    sessions.replace({
      identity: "CP001",
      connection: { close() { /* test double */ } } as OcppConnection,
      transactionCounter: 0,
    });
    const base = await listen(sessions, new SimulatorRegistry());
    const rejected = await post(base, { chargePointIdentity: "CP001", selection: { suiteIds: ["simulator-negative"] } });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toBe(
      "Station CP001 is missing capability simulator-control required by cases: remote-start-rejected, reset-call-error, get-configuration-timeout, delayed-trigger-heartbeat",
    );
    expect(create).not.toHaveBeenCalled();

    create.mockImplementation(async (doc: { chargePointIdentity: string }) => ({
      _id: "run-1",
      toObject() {
        return {
          ...doc,
          _id: "run-1",
          createdAt: new Date("2026-10-06T00:00:00.000Z"),
          results: [],
        };
      },
    }));
    const accepted = await post(base, { chargePointIdentity: "CP001", caseIds: ["heartbeat"] });
    expect(accepted.status).toBe(202);
    expect(create).toHaveBeenCalledOnce();
  });

  it("rejects an invalid profile before the run is stored", async () => {
    const sessions = new SessionRegistry();
    sessions.replace({
      identity: "CP001",
      connection: { close() { /* unused */ } } as OcppConnection,
      transactionCounter: 0,
    });
    const base = await listen(sessions, new SimulatorRegistry());
    const rejected = await post(base, {
      chargePointIdentity: "CP001",
      caseIds: ["heartbeat"],
      profile: { schemaVersion: "9", parameters: {} },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/schemaVersion/);
    expect(create).not.toHaveBeenCalled();

    create.mockImplementation(async (doc: { chargePointIdentity: string }) => ({
      _id: "run-2",
      toObject() {
        return { ...doc, _id: "run-2", createdAt: new Date("2026-10-06T00:00:00.000Z"), results: [] };
      },
    }));
    const accepted = await post(base, { chargePointIdentity: "CP001", caseIds: ["heartbeat"] });
    expect(accepted.status).toBe(202);
  });

  it("confirms a clean fault list before and after simulator commands", async () => {
    const faults = new Map<string, ReturnType<typeof validateFaultRule>>();
    let sendToCharger: (text: string) => void = () => undefined;
    let sendToApi: (text: string) => void = () => undefined;
    const charger = new ControlChannel((text) => sendToApi(text), {
      onRequest: (request) => {
        if (request.action === "clear-all-faults") {
          faults.clear();
          return { cleared: 0 };
        }
        if (request.action === "list-faults") {
          return {
            faults: [...faults.values()].map((rule) => ({
              id: rule.id,
              action: rule.match.action,
              occurrence: rule.match.occurrence,
              effectType: rule.effect.type,
            })),
          };
        }
        if (request.action === "arm-fault") {
          const rule = validateFaultRule(request.payload);
          faults.set(rule.id, rule);
          return { armed: true };
        }
        if (request.action === "clear-fault") {
          const id = String((request.payload as { id?: string }).id);
          const cleared = faults.delete(id);
          return { cleared, alreadyConsumed: !cleared };
        }
        return {};
      },
    });
    const api = new ControlChannel((text) => sendToCharger(text));
    sendToCharger = (text) => charger.handleRaw(text);
    sendToApi = (text) => api.handleRaw(text);
    faults.set("stale", validateFaultRule({
      id: "stale",
      consume: "once",
      match: { action: "Reset" },
      effect: { type: "suppress-response" },
    }));
    const simulators = new SimulatorRegistry();
    simulators.accept(validateHello({
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      chargePointIdentity: "CP001",
      simulatorName: "Pratvoltix Mock",
      simulatorVersion: "0.1.0",
      capabilities: [SIMULATOR_CAPABILITY],
    }), api, () => undefined);
    await simulators.ensureClean("CP001");
    expect(faults.size).toBe(0);
    expect(simulators.get("CP001")?.lastCleanup?.ok).toBe(true);
    await simulators.controller("CP001").armFault(validateFaultRule({
      id: "later",
      consume: "once",
      match: { action: "Reset" },
      effect: { type: "call-result", payload: { status: "Rejected" } },
    }));
    await simulators.finish("CP001");
    expect(faults.size).toBe(0);
    expect(simulators.get("CP001")?.lastCleanup?.ok).toBe(true);
    expect(simulators.get("CP001")?.activeFaults).toEqual([]);
  });

  async function listen(sessions: SessionRegistry, simulators: SimulatorRegistry): Promise<string> {
    const app = createApp(sessions, simulators);
    server = createServer(app);
    attachOcppServer(server, sessions);
    attachSimulatorControl(server, simulators);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }
});

function hello(base: string, identity: string): Promise<WebSocket> {
  const socket = new WebSocket(base.replace("http", "ws") + "/lab-control", [CONTROL_SUBPROTOCOL]);
  return new Promise((resolve, reject) => {
    socket.on("error", reject);
    socket.on("open", () => {
      socket.send(JSON.stringify({
        type: "request",
        requestId: `hello-${identity}`,
        action: "hello",
        payload: {
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          chargePointIdentity: identity,
          simulatorName: "Pratvoltix Mock",
          simulatorVersion: "0.1.0",
          capabilities: [SIMULATOR_CAPABILITY],
        },
      }));
    });
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as { type?: string; requestId?: string; action?: string; ok?: boolean };
      if (message.type === "request" && message.requestId) {
        const payload = message.action === "list-faults" ? { faults: [] } : {};
        socket.send(JSON.stringify({ type: "response", requestId: message.requestId, ok: true, payload }));
        return;
      }
      if (message.ok) {
        resolve(socket);
      } else if (message.type === "response") {
        reject(new Error(String(data)));
      }
    });
  });
}

async function post(base: string, body: unknown): Promise<{ status: number; body: { error?: string } }> {
  const response = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { error?: string } };
}
