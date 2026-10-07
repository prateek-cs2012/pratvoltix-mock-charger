import { describe, expect, it } from "vitest";
import { validateFaultRule, validateReconnectStormConfig } from "./faults.js";
import { ControlProtocolError } from "./errors.js";

describe("validateReconnectStormConfig", () => {
  it("accepts valid config", () => {
    const config = validateReconnectStormConfig({
      burstCount: 5,
      burstDelayMs: 100,
      intervalMs: 1000,
    });
    expect(config.burstCount).toBe(5);
    expect(config.burstDelayMs).toBe(100);
    expect(config.intervalMs).toBe(1000);
  });

  it("rejects non-object input", () => {
    expect(() => validateReconnectStormConfig(null)).toThrow(ControlProtocolError);
    expect(() => validateReconnectStormConfig("string")).toThrow(ControlProtocolError);
    expect(() => validateReconnectStormConfig([])).toThrow(ControlProtocolError);
  });

  it("rejects invalid burstCount", () => {
    expect(() => validateReconnectStormConfig({ burstCount: 0, burstDelayMs: 100, intervalMs: 1000 })).toThrow(/burstCount/);
    expect(() => validateReconnectStormConfig({ burstCount: 101, burstDelayMs: 100, intervalMs: 1000 })).toThrow(/burstCount/);
    expect(() => validateReconnectStormConfig({ burstCount: 1.5, burstDelayMs: 100, intervalMs: 1000 })).toThrow(/burstCount/);
    expect(() => validateReconnectStormConfig({ burstCount: "5", burstDelayMs: 100, intervalMs: 1000 })).toThrow(/burstCount/);
  });

  it("rejects invalid burstDelayMs", () => {
    expect(() => validateReconnectStormConfig({ burstCount: 5, burstDelayMs: -1, intervalMs: 1000 })).toThrow(/burstDelayMs/);
    expect(() => validateReconnectStormConfig({ burstCount: 5, burstDelayMs: 35000, intervalMs: 1000 })).toThrow(/burstDelayMs/);
    expect(() => validateReconnectStormConfig({ burstCount: 5, burstDelayMs: "100", intervalMs: 1000 })).toThrow(/burstDelayMs/);
  });

  it("rejects invalid intervalMs", () => {
    expect(() => validateReconnectStormConfig({ burstCount: 5, burstDelayMs: 100, intervalMs: -1 })).toThrow(/intervalMs/);
    expect(() => validateReconnectStormConfig({ burstCount: 5, burstDelayMs: 100, intervalMs: 35000 })).toThrow(/intervalMs/);
    expect(() => validateReconnectStormConfig({ burstCount: 5, burstDelayMs: 100, intervalMs: "1000" })).toThrow(/intervalMs/);
  });
});

describe("validateFaultRule with reconnect-storm effect", () => {
  it("accepts valid reconnect-storm effect", () => {
    const rule = validateFaultRule({
      id: "storm-test",
      consume: "once",
      match: { action: "BootNotification", occurrence: 1 },
      effect: { type: "reconnect-storm", burstCount: 5, burstDelayMs: 100, intervalMs: 1000 },
    });
    expect(rule.effect.type).toBe("reconnect-storm");
    if (rule.effect.type === "reconnect-storm") {
      expect(rule.effect.burstCount).toBe(5);
      expect(rule.effect.burstDelayMs).toBe(100);
      expect(rule.effect.intervalMs).toBe(1000);
    }
  });

  it("rejects reconnect-storm with invalid parameters", () => {
    expect(() => validateFaultRule({
      id: "storm-bad",
      consume: "once",
      match: { action: "BootNotification" },
      effect: { type: "reconnect-storm", burstCount: 0, burstDelayMs: 100, intervalMs: 1000 },
    })).toThrow(/burstCount/);

    expect(() => validateFaultRule({
      id: "storm-bad",
      consume: "once",
      match: { action: "BootNotification" },
      effect: { type: "reconnect-storm", burstCount: 5, burstDelayMs: -1, intervalMs: 1000 },
    })).toThrow(/burstDelayMs/);

    expect(() => validateFaultRule({
      id: "storm-bad",
      consume: "once",
      match: { action: "BootNotification" },
      effect: { type: "reconnect-storm", burstCount: 5, burstDelayMs: 100, intervalMs: 50000 },
    })).toThrow(/intervalMs/);
  });
});
