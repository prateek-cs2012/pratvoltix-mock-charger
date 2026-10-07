import { Ocpp16Action, OcppConnection, OcppTimeoutError, linkTransports } from "@pratvoltix/ocpp";
import { MAX_ACTIVE_FAULTS, validateFaultRule } from "@pratvoltix/simulator-control";
import { describe, expect, it } from "vitest";
import { FaultEngine } from "./fault-engine.js";
import { MockChargePoint } from "./mock-charge-point.js";

describe("FaultEngine", () => {
  it("rejects duplicate ids and more than the active-rule limit", () => {
    const engine = new FaultEngine();
    engine.arm(rule("one", "Reset"));
    expect(() => engine.arm(rule("one", "Reset"))).toThrow(/already armed/);
    for (let index = 2; index <= MAX_ACTIVE_FAULTS; index += 1) {
      engine.arm(rule(`rule-${index}`, "Heartbeat"));
    }
    expect(() => engine.arm(rule("overflow", "Heartbeat"))).toThrow(/At most/);
  });

  it("matches by action and occurrence in arm order, then consumes the rule", () => {
    const engine = new FaultEngine();
    engine.arm(rule("second-reset", "Reset", 2));
    engine.arm(rule("first-reset", "Reset", 1));
    expect(engine.take("Heartbeat")).toBeUndefined();
    expect(engine.take("Reset")?.type).toBe("call-result");
    expect(engine.list().map((fault) => fault.id)).toEqual(["second-reset"]);
    expect(engine.take("Reset")?.type).toBe("call-error");
    expect(engine.take("Reset")).toBeUndefined();
    expect(engine.clear("second-reset")).toEqual({ cleared: false, alreadyConsumed: true });
  });
});

describe("fault effects", () => {
  it("applies delay, call result, call error, suppression, and ocpp disconnect", async () => {
    const faults = new FaultEngine();
    let disconnected = false;
    const { csms, chargePoint } = pair(faults, () => {
      disconnected = true;
    });

    faults.arm(validateFaultRule({ id: "delay", consume: "once", match: { action: Ocpp16Action.GetConfiguration }, effect: { type: "delay", delayMs: 30 } }));
    const started = Date.now();
    await expect(csms.call(Ocpp16Action.GetConfiguration, {})).resolves.toHaveProperty("configurationKey");
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    await expect(csms.call(Ocpp16Action.GetConfiguration, {})).resolves.toHaveProperty("configurationKey");

    faults.arm(validateFaultRule({
      id: "rejected",
      consume: "once",
      match: { action: Ocpp16Action.RemoteStartTransaction },
      effect: { type: "call-result", payload: { status: "Rejected" } },
    }));
    await expect(csms.call(Ocpp16Action.RemoteStartTransaction, { idTag: "TAG1" })).resolves.toEqual({ status: "Rejected" });
    await expect(csms.call(Ocpp16Action.RemoteStartTransaction, { idTag: "TAG1" })).resolves.toMatchObject({ status: "Accepted" });

    faults.arm(validateFaultRule({
      id: "reset-error",
      consume: "once",
      match: { action: Ocpp16Action.Reset },
      effect: { type: "call-error", errorCode: "InternalError", description: "Injected reset failure", details: { source: "lab" } },
    }));
    await expect(csms.call(Ocpp16Action.Reset, { type: "Soft" })).rejects.toMatchObject({
      name: "OcppCallError",
      errorCode: "InternalError",
      errorDescription: "Injected reset failure",
      errorDetails: { source: "lab" },
    });
    expect(disconnected).toBe(false);

    faults.arm(validateFaultRule({
      id: "silent",
      consume: "once",
      match: { action: Ocpp16Action.GetConfiguration },
      effect: { type: "suppress-response" },
    }));
    await expect(csms.call(Ocpp16Action.GetConfiguration, {}, 40)).rejects.toBeInstanceOf(OcppTimeoutError);
    await expect(csms.call(Ocpp16Action.GetConfiguration, {}, 500)).resolves.toHaveProperty("configurationKey");

    faults.arm(validateFaultRule({
      id: "drop",
      consume: "once",
      match: { action: Ocpp16Action.ClearCache },
      effect: { type: "disconnect" },
    }));
    const pending = csms.call(Ocpp16Action.ClearCache, {}, 200);
    await expect(pending).rejects.toThrow(/closed|timed out|Timed out/i);
    expect(disconnected).toBe(true);
    chargePoint.close();
  });

  it("keeps handling calls when the fault engine throws", async () => {
    const faults = {
      take() {
        throw new Error("engine exploded");
      },
    } as unknown as FaultEngine;
    const { csms, chargePoint } = pair(faults);
    await expect(csms.call(Ocpp16Action.GetConfiguration, {})).resolves.toHaveProperty("configurationKey");
    chargePoint.close();
  });
});

function rule(id: string, action: string, occurrence = 1) {
  return validateFaultRule({
    id,
    consume: "once",
    match: { action, occurrence },
    effect: occurrence === 1
      ? { type: "call-result", payload: { status: "Rejected" } }
      : { type: "call-error", errorCode: "InternalError", description: "later" },
  });
}

function pair(faults?: FaultEngine, disconnectOcpp?: () => void) {
  const transports = linkTransports();
  const csms = new OcppConnection(transports.left, { defaultTimeoutMs: 500 });
  const station = new OcppConnection(transports.right, { defaultTimeoutMs: 500 });
  const chargePoint = new MockChargePoint(station, { identity: "CP001" }, faults, { disconnectOcpp });
  return { csms, chargePoint };
}
