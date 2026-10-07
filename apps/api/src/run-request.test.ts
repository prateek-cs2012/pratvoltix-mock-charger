import { describe, expect, it } from "vitest";
import { HttpError } from "./http-error.js";
import { prepareRun } from "./run-request.js";

describe("prepareRun", () => {
  it("keeps the legacy caseIds request and snapshots the resolved plan", () => {
    const prepared = prepareRun({
      chargePointIdentity: "CP001",
      caseIds: ["soft-reset", "heartbeat", "heartbeat"],
    });

    expect(prepared.caseIds).toEqual(["soft-reset", "heartbeat"]);
    expect(prepared.selection).toEqual({
      caseIds: ["soft-reset", "heartbeat"],
      scenarioIds: [],
      suiteIds: [],
    });
    expect(prepared.plan.catalogVersion).toBe("1");
    expect(prepared.plan.cases.map((testCase) => testCase.id)).toEqual(["soft-reset", "heartbeat"]);
    expect(prepared.plan.cases[0]).toMatchObject({
      id: "soft-reset",
      title: "Soft reset",
      version: "1.6",
    });
    expect(prepared.profile.name).toBe("default-ocpp16");
    expect(prepared.profile.parameters.idTag).toBe("TEST-TAG-001");
    expect(prepared.profile.overridden).toEqual([]);
  });

  it("resolves a partial profile and explicit overrides before a run is stored", () => {
    const prepared = prepareRun({
      chargePointIdentity: "CP001",
      selection: { suiteIds: ["transaction"] },
      profile: { schemaVersion: "1", name: "bench-charger", parameters: { idTag: "LAB-CARD-002" } },
      overrides: { callTimeoutMs: 15_000 },
    });
    expect(prepared.profile).toMatchObject({
      name: "bench-charger",
      parameters: { idTag: "LAB-CARD-002", connectorId: 1, callTimeoutMs: 15_000 },
    });
    expect(() =>
      prepareRun({
        chargePointIdentity: "CP001",
        caseIds: ["heartbeat"],
        profile: { schemaVersion: "1", parameters: { connectorId: "1" } },
      }),
    ).toThrow(/connectorId must be an integer/);
  });

  it("resolves a suite selection before a run is queued", () => {
    const prepared = prepareRun({
      chargePointIdentity: "CP001",
      selection: { suiteIds: ["smoke"] },
    });
    expect(prepared.caseIds).toEqual(["boot-notification", "heartbeat", "status-notification"]);
    expect(prepared.plan.selection.suiteIds).toEqual(["smoke"]);
  });

  it("rejects unknown ids and ambiguous bodies", () => {
    expect(() => prepareRun({ chargePointIdentity: "CP001", caseIds: ["missing-case"] })).toThrow(HttpError);
    expect(() => prepareRun({ chargePointIdentity: "CP001", caseIds: ["missing-case"] })).toThrow(/Case "missing-case"/);
    expect(() =>
      prepareRun({
        chargePointIdentity: "CP001",
        caseIds: ["heartbeat"],
        selection: { caseIds: ["heartbeat"] },
      }),
    ).toThrow(/not both/);
    expect(() => prepareRun({ chargePointIdentity: "CP001" })).toThrow(/Provide selection or caseIds/);
    expect(() => prepareRun({ chargePointIdentity: "CP001", selection: { suiteIds: ["nope"] } })).toThrow(
      /Suite "nope" was not found/,
    );
  });

  it("resolves target precedence and rejects incompatible external cases", () => {
    const fromEnv = prepareRun(
      { chargePointIdentity: "CP001", selection: { suiteIds: ["smoke"] } },
      { environmentUrl: "ws://host.docker.internal:9101/independent/{stationId}", defaultBaseUrl: "ws://localhost:4200/ocpp" },
    );
    expect(fromEnv.target).toMatchObject({
      mode: "external",
      configurationSource: "environment",
      resolvedEndpoint: "ws://host.docker.internal:9101/independent/CP001",
      requestedSubprotocol: "ocpp1.6",
    });
    expect(fromEnv.target.rawEndpoint).toBe("ws://host.docker.internal:9101/independent/CP001");

    const explicit = prepareRun(
      {
        chargePointIdentity: "CP001",
        selection: { suiteIds: ["smoke"] },
        target: { mode: "external", urlTemplate: "wss://user:secret@csms.example/ocpp/{stationId}?token=secret" },
      },
      { environmentUrl: "ws://env.example/{stationId}", defaultBaseUrl: "ws://localhost:4200/ocpp" },
    );
    expect(explicit.target.configurationSource).toBe("run");
    expect(explicit.target.resolvedEndpoint).toBe("wss://csms.example/ocpp/CP001?token=redacted");
    expect(JSON.stringify(storedSnapshot(explicit.target))).not.toContain("secret");

    const embedded = prepareRun(
      { chargePointIdentity: "CP001", caseIds: ["heartbeat"], target: { mode: "embedded" } },
      { environmentUrl: "ws://env.example/{stationId}", defaultBaseUrl: "ws://localhost:4200/ocpp" },
    );
    expect(embedded.target.mode).toBe("embedded");
    expect(embedded.target.configurationSource).toBe("run");

    expect(() =>
      prepareRun({
        chargePointIdentity: "CP001",
        caseIds: ["soft-reset"],
        target: { mode: "external", urlTemplate: "ws://probe.example/{stationId}" },
      }),
    ).toThrow(/embedded-only cases: soft-reset/);
    expect(() =>
      prepareRun({
        chargePointIdentity: "CP001",
        caseIds: ["reset-call-error"],
        target: { mode: "external", urlTemplate: "ws://probe.example/{stationId}" },
      }),
    ).toThrow(/adapter-required cases: reset-call-error/);
    expect(() =>
      prepareRun(
        { chargePointIdentity: "CP001", caseIds: ["heartbeat"], target: { mode: "external" } },
        { environmentUrl: "ws://env.example/{stationId}" },
      ),
    ).toThrow(/requires a target URL/);
  });
});

function storedSnapshot(target: { rawEndpoint: string; resolvedEndpoint: string; urlTemplate: string }): unknown {
  const { rawEndpoint: _raw, ...snapshot } = target;
  return snapshot;
}
