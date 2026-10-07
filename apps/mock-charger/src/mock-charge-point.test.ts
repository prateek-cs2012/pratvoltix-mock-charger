import { Ocpp16Action, OcppConnection, linkTransports } from "@pratvoltix/ocpp";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { defaultOcppRunProfile, testCases } from "@pratvoltix/test-cases";
import { runCases } from "@pratvoltix/test-runner";
import { describe, expect, it } from "vitest";
import { MockChargePoint } from "./mock-charge-point.js";

describe("MockChargePoint", () => {
  it("passes the OCPP 1.6 catalog", async () => {
    const { left, right } = linkTransports();
    const csms = new OcppConnection(left);
    const chargePoint = new MockChargePoint(new OcppConnection(right), { identity: "CP001" });

    csms.onCall(async (call) => {
      if (call.action === Ocpp16Action.BootNotification) {
        return { status: "Accepted", currentTime: new Date().toISOString(), interval: 300 };
      }
      if (call.action === Ocpp16Action.Heartbeat || call.action === Ocpp16Action.StatusNotification || call.action === Ocpp16Action.MeterValues) {
        return call.action === Ocpp16Action.Heartbeat ? { currentTime: new Date().toISOString() } : {};
      }
      return {};
    });

    await chargePoint.announce();

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

    chargePoint.close();
    const failed = report.results.filter((result) => result.status !== "passed");
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
  });
});
