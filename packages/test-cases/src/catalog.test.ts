import { Ocpp16Action, OcppConnection, linkTransports } from "@pratvoltix/ocpp";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { runCases } from "@pratvoltix/test-runner";
import { describe, expect, it } from "vitest";
import { testCases } from "./catalog.js";
import { defaultOcppRunProfile } from "./profile.js";

describe("ocpp 1.6 catalog", () => {
  it("passes every case against an in-memory charge point", async () => {
    const { left, right } = linkTransports();
    const csms = new OcppConnection(left);
    const chargePoint = new OcppConnection(right);
    let heartbeatInterval = "60";
    let transactionId: number | null = null;
    let meterWh = 1000;

    chargePoint.onCall(async (call) => {
      if (call.action === Ocpp16Action.TriggerMessage) {
        const requested = call.payload["requestedMessage"];
        setTimeout(() => {
          if (requested === Ocpp16Action.BootNotification) {
            void chargePoint.call(Ocpp16Action.BootNotification, {
              chargePointVendor: "Pratvoltix",
              chargePointModel: "Lab-One",
            });
          } else if (requested === Ocpp16Action.Heartbeat) {
            void chargePoint.call(Ocpp16Action.Heartbeat, {});
          } else if (requested === Ocpp16Action.StatusNotification) {
            void chargePoint.call(Ocpp16Action.StatusNotification, {
              connectorId: 1,
              errorCode: "NoError",
              status: transactionId === null ? "Available" : "Charging",
            });
          }
        }, 0);
        return { status: "Accepted" };
      }

      if (call.action === Ocpp16Action.GetConfiguration) {
        return {
          configurationKey: [
            { key: "HeartbeatInterval", readonly: false, value: heartbeatInterval },
            { key: "NumberOfConnectors", readonly: true, value: "1" },
          ],
        };
      }

      if (call.action === Ocpp16Action.ChangeConfiguration && call.payload["key"] === "HeartbeatInterval") {
        heartbeatInterval = String(call.payload["value"]);
        return { status: "Accepted" };
      }

      if (call.action === Ocpp16Action.RemoteStartTransaction) {
        const idTag = String(call.payload["idTag"]);
        setTimeout(() => {
          void (async () => {
            await chargePoint.call(Ocpp16Action.Authorize, { idTag });
            const started = await chargePoint.call<{ transactionId: number }>(Ocpp16Action.StartTransaction, {
              connectorId: 1,
              idTag,
              meterStart: meterWh,
              timestamp: new Date().toISOString(),
            });
            transactionId = started.transactionId;
            await chargePoint.call(Ocpp16Action.StatusNotification, {
              connectorId: 1,
              errorCode: "NoError",
              status: "Charging",
            });
            await chargePoint.call(Ocpp16Action.MeterValues, {
              connectorId: 1,
              transactionId,
              meterValue: [{ timestamp: new Date().toISOString(), sampledValue: [{ value: String(meterWh) }] }],
            });
          })();
        }, 0);
        return { status: "Accepted" };
      }

      if (call.action === Ocpp16Action.RemoteStopTransaction) {
        setTimeout(() => {
          void (async () => {
            meterWh += 250;
            await chargePoint.call(Ocpp16Action.StopTransaction, {
              transactionId,
              meterStop: meterWh,
              timestamp: new Date().toISOString(),
            });
            transactionId = null;
            await chargePoint.call(Ocpp16Action.StatusNotification, {
              connectorId: 1,
              errorCode: "NoError",
              status: "Available",
            });
          })();
        }, 0);
        return { status: "Accepted" };
      }

      if (call.action === Ocpp16Action.Reset) {
        return { status: "Accepted" };
      }

      return { status: "Accepted" };
    });

    csms.onCall(async (call) => {
      if (call.action === Ocpp16Action.BootNotification) {
        return { status: "Accepted", currentTime: new Date().toISOString(), interval: 60 };
      }
      if (call.action === Ocpp16Action.Heartbeat) {
        return { currentTime: new Date().toISOString() };
      }
      return {};
    });

    const report = await runCases({
      cases: testCases,
      ids: testCases.filter((testCase) => !(testCase.requirements ?? []).includes(SIMULATOR_CAPABILITY)).map((testCase) => testCase.id),
      createContext: (helpers) => ({
        ...helpers,
        peer: csms,
        chargePointId: "CP001",
        profile: defaultOcppRunProfile(),
      }),
    });

    const failed = report.results.filter((result) => result.status !== "passed");
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(report.status).toBe("passed");
  });
});
