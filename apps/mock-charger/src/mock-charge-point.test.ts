import { Ocpp16Action, OcppConnection, linkTransports } from "@pratvoltix/ocpp";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { defaultOcppRunProfile, testCases } from "@pratvoltix/test-cases";
import { runCases } from "@pratvoltix/test-runner";
import { describe, expect, it } from "vitest";
import { FaultEngine } from "./fault-engine.js";
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

describe("LocalAuthList and GetLocalListVersion", () => {
  it("returns 0 for GetLocalListVersion before any SendLocalList", async () => {
    const { left, right } = linkTransports();
    const csms = new OcppConnection(left);
    const chargePoint = new MockChargePoint(new OcppConnection(right), { identity: "CP001" });

    csms.onCall(async (call) => {
      if (call.action === Ocpp16Action.BootNotification) {
        return { status: "Accepted", currentTime: new Date().toISOString(), interval: 300 };
      }
      return {};
    });

    await chargePoint.announce();

    const versionBefore = await csms.call<{ listVersion: number }>(Ocpp16Action.GetLocalListVersion, {});
    expect(versionBefore.listVersion).toBe(0);
    chargePoint.close();
  });

  it("returns the listVersion from Accepted SendLocalList (Full)", async () => {
    const { left, right } = linkTransports();
    const csms = new OcppConnection(left);
    const chargePoint = new MockChargePoint(new OcppConnection(right), { identity: "CP001" });

    csms.onCall(async (call) => {
      if (call.action === Ocpp16Action.BootNotification) {
        return { status: "Accepted", currentTime: new Date().toISOString(), interval: 300 };
      }
      return {};
    });

    await chargePoint.announce();

    const sendResult = await csms.call<{ status: string }>(Ocpp16Action.SendLocalList, {
      listVersion: 42,
      updateType: "Full",
      localAuthorizationList: [{ idTag: "TAG001", idTagInfo: { status: "Accepted" } }],
    });
    expect(sendResult.status).toBe("Accepted");

    const versionAfter = await csms.call<{ listVersion: number }>(Ocpp16Action.GetLocalListVersion, {});
    expect(versionAfter.listVersion).toBe(42);

    chargePoint.close();
  });

  it("returns the listVersion from Accepted SendLocalList (Differential)", async () => {
    const { left, right } = linkTransports();
    const csms = new OcppConnection(left);
    const chargePoint = new MockChargePoint(new OcppConnection(right), { identity: "CP001" });

    csms.onCall(async (call) => {
      if (call.action === Ocpp16Action.BootNotification) {
        return { status: "Accepted", currentTime: new Date().toISOString(), interval: 300 };
      }
      return {};
    });

    await chargePoint.announce();

    await csms.call(Ocpp16Action.SendLocalList, {
      listVersion: 10,
      updateType: "Full",
      localAuthorizationList: [{ idTag: "TAG001", idTagInfo: { status: "Accepted" } }],
    });

    const diffResult = await csms.call<{ status: string }>(Ocpp16Action.SendLocalList, {
      listVersion: 15,
      updateType: "Differential",
      localAuthorizationList: [{ idTag: "TAG002", idTagInfo: { status: "Blocked" } }],
    });
    expect(diffResult.status).toBe("Accepted");

    const version = await csms.call<{ listVersion: number }>(Ocpp16Action.GetLocalListVersion, {});
    expect(version.listVersion).toBe(15);

    chargePoint.close();
  });
});

describe("Malformed response injection", () => {
  it("invokes sendRawOcpp with the raw payload and does not return a normal response", async () => {
    const { left, right } = linkTransports();
    const csms = new OcppConnection(left);
    const faults = new FaultEngine();
    const rawPayloadsSent: string[] = [];

    const chargePoint = new MockChargePoint(
      new OcppConnection(right),
      { identity: "CP001" },
      faults,
      {
        sendRawOcpp: (data) => rawPayloadsSent.push(data),
      },
    );

    csms.onCall(async (call) => {
      if (call.action === Ocpp16Action.BootNotification) {
        return { status: "Accepted", currentTime: new Date().toISOString(), interval: 300 };
      }
      return {};
    });

    await chargePoint.announce();

    faults.arm({
      id: "malformed-getconfig",
      consume: "once",
      match: { action: Ocpp16Action.GetConfiguration, occurrence: 1 },
      effect: { type: "malformed-response", rawPayload: "broken{{{json" },
    });

    const callPromise = csms.call(Ocpp16Action.GetConfiguration, { key: [] }, 500);

    await expect(callPromise).rejects.toThrow();
    expect(rawPayloadsSent).toEqual(["broken{{{json"]);
    expect(faults.list()).toEqual([]);

    chargePoint.close();
  });
});

describe("Duplicate Start/Stop idempotency", () => {
  it("does not double-call CSMS for duplicate StartTransaction", async () => {
    const { left, right } = linkTransports();
    const csms = new OcppConnection(left);
    const chargePoint = new MockChargePoint(new OcppConnection(right), { identity: "CP001" });

    let startTxCount = 0;
    csms.onCall(async (call) => {
      if (call.action === Ocpp16Action.BootNotification) {
        return { status: "Accepted", currentTime: new Date().toISOString(), interval: 300 };
      }
      if (call.action === Ocpp16Action.Authorize) {
        return { idTagInfo: { status: "Accepted" } };
      }
      if (call.action === Ocpp16Action.StartTransaction) {
        startTxCount += 1;
        return { transactionId: 12345, idTagInfo: { status: "Accepted" } };
      }
      return {};
    });

    await chargePoint.announce();

    await csms.call(Ocpp16Action.RemoteStartTransaction, { connectorId: 1, idTag: "TAG001" });
    await new Promise((r) => setTimeout(r, 100));
    expect(startTxCount).toBe(1);

    chargePoint.close();
  });

  it("does not double-call CSMS for duplicate StopTransaction", async () => {
    const { left, right } = linkTransports();
    const csms = new OcppConnection(left);
    const chargePoint = new MockChargePoint(new OcppConnection(right), { identity: "CP001" });

    let stopTxCount = 0;
    csms.onCall(async (call) => {
      if (call.action === Ocpp16Action.BootNotification) {
        return { status: "Accepted", currentTime: new Date().toISOString(), interval: 300 };
      }
      if (call.action === Ocpp16Action.Authorize) {
        return { idTagInfo: { status: "Accepted" } };
      }
      if (call.action === Ocpp16Action.StartTransaction) {
        return { transactionId: 12345, idTagInfo: { status: "Accepted" } };
      }
      if (call.action === Ocpp16Action.StopTransaction) {
        stopTxCount += 1;
        return { idTagInfo: { status: "Accepted" } };
      }
      return {};
    });

    await chargePoint.announce();

    await csms.call(Ocpp16Action.RemoteStartTransaction, { connectorId: 1, idTag: "TAG001" });
    await new Promise((r) => setTimeout(r, 100));
    expect(chargePoint.getState().transactionId).toBe(12345);

    await csms.call(Ocpp16Action.RemoteStopTransaction, { transactionId: 12345 });
    await new Promise((r) => setTimeout(r, 100));
    expect(stopTxCount).toBe(1);
    expect(chargePoint.getState().transactionId).toBeNull();

    chargePoint.close();
  });
});

describe("Offline transaction upload", () => {
  it("uses CSMS-assigned transactionId for StopTransaction", async () => {
    const { left, right } = linkTransports();
    const csms = new OcppConnection(left);
    const chargePoint = new MockChargePoint(new OcppConnection(right), { identity: "CP001" });

    let startTxPayloads: unknown[] = [];
    let stopTxPayloads: unknown[] = [];
    csms.onCall(async (call) => {
      if (call.action === Ocpp16Action.BootNotification) {
        return { status: "Accepted", currentTime: new Date().toISOString(), interval: 300 };
      }
      if (call.action === Ocpp16Action.StartTransaction) {
        startTxPayloads.push(call.payload);
        return { transactionId: 99999, idTagInfo: { status: "Accepted" } };
      }
      if (call.action === Ocpp16Action.StopTransaction) {
        stopTxPayloads.push(call.payload);
        return { idTagInfo: { status: "Accepted" } };
      }
      return {};
    });

    await chargePoint.announce();

    chargePoint.queueOfflineTransaction({
      localId: 1,
      connectorId: 1,
      idTag: "OFFLINE001",
      meterStart: 5000,
      meterStop: 5500,
      startTimestamp: "2024-01-15T10:00:00Z",
      stopTimestamp: "2024-01-15T10:30:00Z",
      reason: "Local",
    });

    const uploaded = await chargePoint.uploadOfflineTransactions();
    expect(uploaded).toBe(1);
    expect(startTxPayloads.length).toBe(1);
    expect(stopTxPayloads.length).toBe(1);
    expect((stopTxPayloads[0] as { transactionId: number }).transactionId).toBe(99999);

    chargePoint.close();
  });
});
