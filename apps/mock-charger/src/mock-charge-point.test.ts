import { Ocpp16Action, OcppConnection, linkTransports } from "@pratvoltix/ocpp";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { defaultOcppRunProfile, testCases } from "@pratvoltix/test-cases";
import { runCases } from "@pratvoltix/test-runner";
import { describe, expect, it } from "vitest";
import { MockChargePoint, type ChargePointState } from "./mock-charge-point.js";

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

describe("ChargePointState persistence", () => {
  it("initializes with default state when no initialState provided", () => {
    const { right } = linkTransports();
    const chargePoint = new MockChargePoint(new OcppConnection(right), { identity: "CP001" });
    const state = chargePoint.getState();
    expect(state.transactionId).toBeNull();
    expect(state.connectorStatus).toBe("Available");
    expect(state.meterWh).toBe(1_000);
    expect(state.idTag).toBeNull();
    chargePoint.close();
  });

  it("initializes with provided initialState", () => {
    const { right } = linkTransports();
    const initialState: ChargePointState = {
      transactionId: 12345,
      connectorStatus: "Charging",
      meterWh: 2_500,
      idTag: "TAG001",
    };
    const chargePoint = new MockChargePoint(new OcppConnection(right), { identity: "CP001", initialState });
    const state = chargePoint.getState();
    expect(state.transactionId).toBe(12345);
    expect(state.connectorStatus).toBe("Charging");
    expect(state.meterWh).toBe(2_500);
    expect(state.idTag).toBe("TAG001");
    expect(chargePoint.hasActiveTransaction()).toBe(true);
    chargePoint.close();
  });

  it("sends correct status notification after announce when restored as Charging", async () => {
    const { left, right } = linkTransports();
    const csms = new OcppConnection(left);
    const initialState: ChargePointState = {
      transactionId: 12345,
      connectorStatus: "Charging",
      meterWh: 2_500,
      idTag: "TAG001",
    };
    const chargePoint = new MockChargePoint(new OcppConnection(right), { identity: "CP001", initialState });
    
    let statusReceived: string | undefined;
    csms.onCall(async (call) => {
      if (call.action === Ocpp16Action.BootNotification) {
        return { status: "Accepted", currentTime: new Date().toISOString(), interval: 300 };
      }
      if (call.action === Ocpp16Action.StatusNotification) {
        statusReceived = call.payload["status"] as string;
        return {};
      }
      return {};
    });

    await chargePoint.announce();
    expect(statusReceived).toBe("Charging");
    chargePoint.close();
  });

  it("sends Unavailable status if restored as Unavailable", async () => {
    const { left, right } = linkTransports();
    const csms = new OcppConnection(left);
    const initialState: ChargePointState = {
      transactionId: null,
      connectorStatus: "Unavailable",
      meterWh: 1_000,
      idTag: null,
    };
    const chargePoint = new MockChargePoint(new OcppConnection(right), { identity: "CP001", initialState });
    
    let statusReceived: string | undefined;
    csms.onCall(async (call) => {
      if (call.action === Ocpp16Action.BootNotification) {
        return { status: "Accepted", currentTime: new Date().toISOString(), interval: 300 };
      }
      if (call.action === Ocpp16Action.StatusNotification) {
        statusReceived = call.payload["status"] as string;
        return {};
      }
      return {};
    });

    await chargePoint.announce();
    expect(statusReceived).toBe("Unavailable");
    chargePoint.close();
  });

  it("updates state during transaction lifecycle", async () => {
    const { left, right } = linkTransports();
    const csms = new OcppConnection(left);
    const chargePoint = new MockChargePoint(new OcppConnection(right), { identity: "CP001" });
    
    csms.onCall(async (call) => {
      if (call.action === Ocpp16Action.BootNotification) {
        return { status: "Accepted", currentTime: new Date().toISOString(), interval: 300 };
      }
      if (call.action === Ocpp16Action.Authorize) {
        return { idTagInfo: { status: "Accepted" } };
      }
      if (call.action === Ocpp16Action.StartTransaction) {
        return { transactionId: 99999, idTagInfo: { status: "Accepted" } };
      }
      if (call.action === Ocpp16Action.StopTransaction) {
        return { idTagInfo: { status: "Accepted" } };
      }
      return {};
    });

    await chargePoint.announce();
    expect(chargePoint.getState().connectorStatus).toBe("Available");
    expect(chargePoint.getState().transactionId).toBeNull();

    const startResult = await csms.call<{ status: string }>(Ocpp16Action.RemoteStartTransaction, { connectorId: 1, idTag: "TAG001" });
    expect(startResult.status).toBe("Accepted");
    await new Promise((r) => setTimeout(r, 100));

    expect(chargePoint.getState().connectorStatus).toBe("Charging");
    expect(chargePoint.getState().transactionId).toBe(99999);
    expect(chargePoint.getState().idTag).toBe("TAG001");

    const stopResult = await csms.call<{ status: string }>(Ocpp16Action.RemoteStopTransaction, { transactionId: 99999 });
    expect(stopResult.status).toBe("Accepted");
    await new Promise((r) => setTimeout(r, 100));

    expect(chargePoint.getState().connectorStatus).toBe("Available");
    expect(chargePoint.getState().transactionId).toBeNull();
    expect(chargePoint.getState().idTag).toBeNull();
    chargePoint.close();
  });
});
