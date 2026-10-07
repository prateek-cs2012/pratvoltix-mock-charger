import { Ocpp16Action, OcppConnection, linkTransports, type OcppObservedFrame } from "@pratvoltix/ocpp";
import { runCases } from "@pratvoltix/test-runner";
import { resolveOcppRunProfile, testCases } from "@pratvoltix/test-cases";
import { describe, expect, it } from "vitest";
import { SimulatorControlClient, nextControlBackoff } from "./control-client.js";
import type { ControlSocket } from "./control-client.js";
import { FaultEngine } from "./fault-engine.js";
import { localSimulatorController } from "./control-client.js";
import { MockChargePoint } from "./mock-charge-point.js";

describe("control reconnect", () => {
  it("backs off, clears faults when the socket opens, and reconnects after close", async () => {
    expect(nextControlBackoff(0)).toBe(200);
    expect(nextControlBackoff(1)).toBe(400);
    expect(nextControlBackoff(20)).toBe(5_000);

    const faults = new FaultEngine();
    faults.arm({
      id: "stale",
      consume: "once",
      match: { action: "Reset", occurrence: 1 },
      effect: { type: "call-error", errorCode: "InternalError", description: "stale" },
    });
    const sockets: FakeSocket[] = [];
    const scheduled: number[] = [];
    const client = new SimulatorControlClient({
      url: "ws://api:8080/lab-control",
      identity: "CP001",
      simulatorName: "Pratvoltix Mock",
      simulatorVersion: "0.1.0",
      faults,
      disconnectOcpp: () => undefined,
      openSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      schedule: (callback, delayMs) => {
        scheduled.push(delayMs);
        return { cancel() { /* unused */ } };
      },
    });
    client.start();
    const first = sockets[0];
    expect(first).toBeDefined();
    first?.emit("open");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(faults.list()).toEqual([]);
    expect(first?.sent[0]).toContain("\"action\":\"hello\"");
    first?.emit("close");
    expect(scheduled).toEqual([200]);
    client.stop();
  });
});

describe("negative catalog cases", () => {
  it("passes the simulator-only cases and keeps control messages off the OCPP trace", async () => {
    const faults = new FaultEngine();
    const transports = linkTransports();
    const frames: OcppObservedFrame[] = [];
    const csms = new OcppConnection(transports.left, { defaultTimeoutMs: 1_000 });
    csms.observe((frame) => frames.push(frame));
    const station = new OcppConnection(transports.right, { defaultTimeoutMs: 1_000 });
    const chargePoint = new MockChargePoint(station, { identity: "CP001" }, faults);
    csms.onCall(async (call) => {
      if (call.action === Ocpp16Action.Heartbeat) {
        return { currentTime: new Date().toISOString() };
      }
      return {};
    });

    const profile = resolveOcppRunProfile({
      profile: {
        schemaVersion: "1",
        name: "negative-timing",
        parameters: {
          idTag: "LAB-CARD-009",
          simulatorDelayMs: 80,
          simulatorTimeoutMs: 200,
          callTimeoutMs: 2_000,
          eventTimeoutMs: 2_000,
        },
      },
    });
    const report = await runCases({
      cases: testCases,
      ids: ["remote-start-rejected", "reset-call-error", "get-configuration-timeout", "delayed-trigger-heartbeat"],
      createContext: (helpers) => ({
        ...helpers,
        peer: csms,
        chargePointId: "CP001",
        profile,
        simulator: localSimulatorController(faults),
      }),
    });

    expect(report.results.map((result) => `${result.id}:${result.status}:${result.error ?? ""}`)).toEqual([
      "remote-start-rejected:passed:",
      "reset-call-error:passed:",
      "get-configuration-timeout:passed:",
      "delayed-trigger-heartbeat:passed:",
    ]);
    expect(faults.list()).toEqual([]);
    const serialized = JSON.stringify(frames);
    expect(serialized).not.toContain("arm-fault");
    expect(serialized).not.toContain("pratvoltix-lab-control");
    expect(serialized).toContain("LAB-CARD-009");
    expect(frames.some((frame) => frame.messageType === "CALLRESULT" && frame.action === Ocpp16Action.RemoteStartTransaction)).toBe(true);
    expect(frames.some((frame) => frame.messageType === "CALLERROR" && frame.action === Ocpp16Action.Reset)).toBe(true);
    const configurationCalls = frames.filter((frame) => frame.action === Ocpp16Action.GetConfiguration && frame.messageType === "CALL");
    const configurationResults = frames.filter((frame) => frame.action === Ocpp16Action.GetConfiguration && frame.messageType === "CALLRESULT");
    expect(configurationCalls.length).toBe(configurationResults.length + 1);
    const trigger = frames.filter((frame) => frame.action === Ocpp16Action.TriggerMessage);
    expect(trigger.map((frame) => frame.messageType)).toEqual(["CALL", "CALLRESULT"]);
    chargePoint.close();
  });
});

class FakeSocket implements ControlSocket {
  readonly sent: string[] = [];
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit("close");
  }

  on(event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void): void {
    const current = this.handlers.get(event) ?? [];
    current.push(listener);
    this.handlers.set(event, current);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.handlers.get(event) ?? []) {
      listener(...args);
    }
  }
}
