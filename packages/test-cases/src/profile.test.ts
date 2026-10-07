import { describe, expect, it } from "vitest";
import { PROFILE_PARAMETER_NAMES, ProfileError, defaultOcppRunProfile, parseProfileOverride, resolveOcppRunProfile } from "./profile.js";

const defaults = defaultOcppRunProfile();

describe("run profiles", () => {
  it("validates the default profile and keeps parameter order", () => {
    expect(defaults.schemaVersion).toBe("1");
    expect(defaults.name).toBe("default-ocpp16");
    expect(defaults.overridden).toEqual([]);
    expect(Object.keys(defaults.parameters)).toEqual([...PROFILE_PARAMETER_NAMES]);
    expect(defaults.parameters).toMatchObject({
      connectorId: 1,
      idTag: "TEST-TAG-001",
      transactionId: 1001,
      configurationKey: "HeartbeatInterval",
      configurationTestValue: "45",
    });
    expect(Object.isFrozen(defaults.parameters)).toBe(true);
  });

  it("resolves a partial profile and lets explicit overrides win without mutating inputs", () => {
    const profile = {
      schemaVersion: "1" as const,
      name: "bench-charger",
      parameters: { idTag: "LAB-CARD-002", connectorId: 1 },
    };
    const overrides = { connectorId: 2, callTimeoutMs: 15_000 };
    const snapshot = structuredClone({ profile, overrides });
    const resolved = resolveOcppRunProfile({ profile, overrides });
    expect(profile).toEqual(snapshot.profile);
    expect(overrides).toEqual(snapshot.overrides);
    expect(resolved.name).toBe("bench-charger");
    expect(resolved.parameters.idTag).toBe("LAB-CARD-002");
    expect(resolved.parameters.connectorId).toBe(2);
    expect(resolved.parameters.callTimeoutMs).toBe(15_000);
    expect(resolved.parameters.transactionId).toBe(defaults.parameters.transactionId);
    expect(resolved.overridden).toEqual(["connectorId", "idTag", "callTimeoutMs"]);
    expect(() => {
      (resolved.parameters as { connectorId: number }).connectorId = 9;
    }).toThrow();
  });

  it("rejects unknown versions, missing parameters, unknown fields, and invalid types", () => {
    expect(() => resolveOcppRunProfile({ profile: { schemaVersion: "2", parameters: {} } })).toThrow(/schemaVersion/);
    expect(() => resolveOcppRunProfile({ profile: { schemaVersion: "1" } })).toThrow(/parameters are required/);
    expect(() => resolveOcppRunProfile({ profile: [] })).toThrow(/JSON object/);
    expect(() => resolveOcppRunProfile({ profile: { schemaVersion: "1", parameters: {}, extra: true } })).toThrow(/Unknown profile field/);
    expect(() => resolveOcppRunProfile({ overrides: { password: "nope" } })).toThrow(/Unknown profile parameter "password"/);
    expect(() => resolveOcppRunProfile({ overrides: { connectorId: "1" } })).toThrow(/connectorId must be an integer/);
    expect(() => resolveOcppRunProfile({ overrides: { idTag: "" } })).toThrow(/idTag/);
  });

  it("rejects values outside the numeric, id-tag, configuration, and timeout limits", () => {
    expect(() => resolveOcppRunProfile({ overrides: { connectorId: -1 } })).toThrow(/0 to 1000/);
    expect(() => resolveOcppRunProfile({ overrides: { connectorId: 1001 } })).toThrow(/Received 1001/);
    expect(() => resolveOcppRunProfile({ overrides: { transactionId: 0 } })).toThrow(/transactionId/);
    expect(() => resolveOcppRunProfile({ overrides: { transactionId: 2_147_483_648 } })).toThrow(/transactionId/);
    expect(() => resolveOcppRunProfile({ overrides: { idTag: "123456789012345678901" } })).toThrow(/20 characters/);
    expect(() => resolveOcppRunProfile({ overrides: { configurationKey: "k".repeat(101) } })).toThrow(/100 characters/);
    expect(() => resolveOcppRunProfile({ overrides: { configurationTestValue: "v".repeat(501) } })).toThrow(/500 characters/);
    expect(() => resolveOcppRunProfile({ overrides: { callTimeoutMs: 99 } })).toThrow(/callTimeoutMs/);
    expect(() => resolveOcppRunProfile({ overrides: { eventTimeoutMs: 120_001 } })).toThrow(/eventTimeoutMs/);
    expect(() => resolveOcppRunProfile({ overrides: { simulatorDelayMs: -1 } })).toThrow(/simulatorDelayMs/);
    expect(() => resolveOcppRunProfile({ overrides: { simulatorTimeoutMs: 99 } })).toThrow(/simulatorTimeoutMs/);
    expect(() => resolveOcppRunProfile({ overrides: { simulatorTimeoutMs: 30_001 } })).toThrow(/simulatorTimeoutMs/);
  });

  it("parses CLI overrides by parameter type and rejects leading zeros", () => {
    expect(parseProfileOverride("connectorId", "1")).toEqual({ key: "connectorId", value: 1 });
    expect(parseProfileOverride("idTag", "TEST-TAG-002")).toEqual({ key: "idTag", value: "TEST-TAG-002" });
    expect(parseProfileOverride("configurationTestValue", "45")).toEqual({ key: "configurationTestValue", value: "45" });
    expect(() => parseProfileOverride("connectorId", "01")).toThrow(ProfileError);
    expect(() => parseProfileOverride("connectorId", "1.5")).toThrow(ProfileError);
    expect(() => parseProfileOverride("nope", "1")).toThrow(/Unknown profile parameter/);
  });
});
