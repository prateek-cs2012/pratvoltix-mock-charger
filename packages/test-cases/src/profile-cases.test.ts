import { Ocpp16Action, OcppConnection, linkTransports } from "@pratvoltix/ocpp";
import { runCases } from "@pratvoltix/test-runner";
import { describe, expect, it } from "vitest";
import { changeConfigurationCase } from "./cases/change-configuration.case.js";
import { transactionLifecycleCase } from "./cases/transaction-lifecycle.case.js";
import { resolveOcppRunProfile } from "./profile.js";

describe("profile-driven cases", () => {
  it("restores the original configuration value after success and after a failed assertion", async () => {
    const success = await runChange("60", false);
    expect(success.status).toBe("passed");
    expect(success.values).toEqual(["45", "60"]);
    expect(success.current).toBe("60");

    const failed = await runChange("77", true);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("configured test value");
    expect(failed.values).toEqual(["45", "77"]);
    expect(failed.current).toBe("77");
  });

  it("uses the configured connector, id tag, and transaction id", async () => {
    const profile = resolveOcppRunProfile({
      overrides: { connectorId: 2, idTag: "LAB-CARD-002", transactionId: 2001 },
    });
    const { left, right } = linkTransports();
    const csms = new OcppConnection(left, { defaultTimeoutMs: 1_000 });
    const chargePoint = new OcppConnection(right, { defaultTimeoutMs: 1_000 });
    const stopped: number[] = [];
    chargePoint.onCall(async (call) => {
      if (call.action === Ocpp16Action.RemoteStartTransaction) {
        const idTag = String(call.payload["idTag"]);
        const connectorId = call.payload["connectorId"];
        setTimeout(() => {
          void (async () => {
            await chargePoint.call(Ocpp16Action.Authorize, { idTag });
            const started = await chargePoint.call<{ transactionId: number }>(Ocpp16Action.StartTransaction, {
              connectorId,
              idTag,
              meterStart: 10,
              timestamp: new Date().toISOString(),
            });
            await chargePoint.call(Ocpp16Action.StatusNotification, { connectorId, errorCode: "NoError", status: "Charging" });
            await chargePoint.call(Ocpp16Action.MeterValues, {
              connectorId,
              transactionId: started.transactionId,
              meterValue: [{ timestamp: new Date().toISOString(), sampledValue: [{ value: "10" }] }],
            });
          })();
        }, 0);
      }
      if (call.action === Ocpp16Action.RemoteStopTransaction) {
        stopped.push(Number(call.payload["transactionId"]));
        setTimeout(() => {
          void (async () => {
            await chargePoint.call(Ocpp16Action.StopTransaction, {
              transactionId: call.payload["transactionId"],
              meterStop: 20,
              timestamp: new Date().toISOString(),
            });
            await chargePoint.call(Ocpp16Action.StatusNotification, { connectorId: 2, errorCode: "NoError", status: "Available" });
          })();
        }, 0);
      }
      return { status: "Accepted" };
    });

    const report = await runCases({
      cases: [transactionLifecycleCase],
      ids: ["transaction-lifecycle"],
      createContext: (helpers) => ({ ...helpers, peer: csms, chargePointId: "CP002", profile }),
    });
    expect(report.results[0]?.status, report.results[0]?.error).toBe("passed");
    expect(stopped).toEqual([2001]);
  });
});

async function runChange(original: string, failReadBack: boolean) {
  const values: string[] = [];
  let current = original;
  let reads = 0;
  const { left, right } = linkTransports();
  const csms = new OcppConnection(left, { defaultTimeoutMs: 1_000 });
  const chargePoint = new OcppConnection(right, { defaultTimeoutMs: 1_000 });
  chargePoint.onCall(async (call) => {
    if (call.action === Ocpp16Action.ChangeConfiguration) {
      values.push(String(call.payload["value"]));
      current = String(call.payload["value"]);
      return { status: "Accepted" };
    }
    reads += 1;
    const value = failReadBack && reads === 2 ? "wrong" : current;
    return { configurationKey: [{ key: "HeartbeatInterval", value }] };
  });
  const report = await runCases({
    cases: [changeConfigurationCase],
    ids: ["change-configuration"],
    createContext: (helpers) => ({
      ...helpers,
      peer: csms,
      chargePointId: "CP001",
      profile: resolveOcppRunProfile(),
    }),
  });
  return { status: report.results[0]?.status, error: report.results[0]?.error, values, current };
}
