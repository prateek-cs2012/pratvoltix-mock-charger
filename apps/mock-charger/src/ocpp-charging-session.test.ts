import { Ocpp16Action, OcppConnection, linkTransports, type InboundCall } from "@pratvoltix/ocpp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockChargePoint, type ChargePointState, type MockChargePointOptions } from "./mock-charge-point.js";

/** PRAT-244: full OCPP session with realistic MeterValues. */

interface Recorded {
  action: string;
  payload: Record<string, unknown>;
}

interface SampledValue {
  value: string;
  measurand?: string;
  unit?: string;
  context?: string;
}

const T0 = new Date("2026-11-03T10:00:00.000Z");

function setup(options: Partial<MockChargePointOptions> = {}, authStatus = "Accepted", hangStop = false) {
  const { left, right } = linkTransports();
  const csms = new OcppConnection(left);
  const calls: Recorded[] = [];
  csms.onCall(async (call: InboundCall) => {
    calls.push({ action: call.action, payload: call.payload });
    if (hangStop && call.action === Ocpp16Action.StopTransaction) {
      // Socket drops before the CSMS acknowledges the stop.
      return new Promise<never>(() => undefined);
    }
    switch (call.action) {
      case Ocpp16Action.BootNotification:
        return { status: "Accepted", currentTime: new Date().toISOString(), interval: 0 };
      case Ocpp16Action.Authorize:
        return { idTagInfo: { status: authStatus } };
      case Ocpp16Action.StartTransaction:
        return { transactionId: 4242, idTagInfo: { status: "Accepted" } };
      case Ocpp16Action.StopTransaction:
        return { idTagInfo: { status: "Accepted" } };
      default:
        return {};
    }
  });
  const chargePoint = new MockChargePoint(new OcppConnection(right), {
    identity: "CP244",
    random: () => 0.5,
    ...options,
  });
  return { csms, chargePoint, calls };
}

function statuses(calls: Recorded[]): string[] {
  return calls.filter((c) => c.action === Ocpp16Action.StatusNotification).map((c) => String(c.payload["status"]));
}

function meterValues(calls: Recorded[]): SampledValue[][] {
  return calls
    .filter((c) => c.action === Ocpp16Action.MeterValues)
    .map((c) => (c.payload["meterValue"] as Array<{ sampledValue: SampledValue[] }>)[0]!.sampledValue);
}

function measurand(sample: SampledValue[], name: string): SampledValue | undefined {
  return sample.find((v) => v.measurand === name);
}

function stops(calls: Recorded[]): Recorded[] {
  return calls.filter((c) => c.action === Ocpp16Action.StopTransaction);
}

async function remoteStart(csms: OcppConnection): Promise<void> {
  const res = await csms.call<{ status: string }>(Ocpp16Action.RemoteStartTransaction, { connectorId: 1, idTag: "TAG244" });
  expect(res.status).toBe("Accepted");
  await vi.advanceTimersByTimeAsync(0);
}

describe("PRAT-244 charging session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("AC1: sends StatusNotification Preparing before Authorize and StartTransaction", async () => {
    const { csms, chargePoint, calls } = setup();
    await chargePoint.announce();
    calls.length = 0;
    await remoteStart(csms);

    const order = calls.map((c) => (c.action === Ocpp16Action.StatusNotification ? `Status:${String(c.payload["status"])}` : c.action));
    expect(order.slice(0, 5)).toEqual([
      "Status:Preparing",
      Ocpp16Action.Authorize,
      Ocpp16Action.StartTransaction,
      "Status:Charging",
      Ocpp16Action.MeterValues,
    ]);
    chargePoint.close();
  });

  it("AC1: returns to Available when Authorize is rejected after Preparing", async () => {
    const { csms, chargePoint, calls } = setup({}, "Invalid");
    await chargePoint.announce();
    calls.length = 0;
    await remoteStart(csms);

    expect(statuses(calls)).toEqual(["Preparing", "Available"]);
    expect(calls.some((c) => c.action === Ocpp16Action.StartTransaction)).toBe(false);
    expect(chargePoint.getState().connectorStatus).toBe("Available");
    chargePoint.close();
  });

  it("AC1: local start sends Preparing once", async () => {
    const { chargePoint, calls } = setup();
    await chargePoint.announce();
    calls.length = 0;
    await chargePoint.localStart("TAG244");
    expect(statuses(calls).filter((s) => s === "Preparing")).toHaveLength(1);
    chargePoint.close();
  });

  it("AC2: MeterValues carry an integer Wh register from kW × dt plus Power in W, and no SoC", async () => {
    const { csms, chargePoint, calls } = setup({ chargerType: "AC", ratedPowerKw: 22 });
    await chargePoint.announce();
    await remoteStart(csms);

    const begin = meterValues(calls)[0]!;
    expect(measurand(begin, "Energy.Active.Import.Register")).toMatchObject({ value: "1000", unit: "Wh", context: "Transaction.Begin" });
    expect(measurand(begin, "Power.Active.Import")).toMatchObject({ value: "22000", unit: "W" });

    await vi.advanceTimersByTimeAsync(30_000);
    const periodic = meterValues(calls)[1]!;
    const energy = measurand(periodic, "Energy.Active.Import.Register")!;
    // 22 kW × 30 s = 183.3 Wh → integer register 1183
    expect(energy).toMatchObject({ value: "1183", unit: "Wh", context: "Sample.Periodic" });
    expect(Number.isInteger(Number(energy.value))).toBe(true);
    expect(measurand(periodic, "Power.Active.Import")).toMatchObject({ value: "22000", unit: "W" });
    for (const sample of meterValues(calls)) {
      expect(sample.some((v) => v.measurand === "SoC")).toBe(false);
    }
    chargePoint.close();
  });

  it("AC2: DC charger tapers power over a long session", async () => {
    const { csms, chargePoint, calls } = setup({ chargerType: "DC", ratedPowerKw: 60, autoStopMinutes: 0 });
    await chargePoint.announce();
    await remoteStart(csms);
    await vi.advanceTimersByTimeAsync(20 * 60_000);

    const samples = meterValues(calls);
    const early = Number(measurand(samples[1]!, "Power.Active.Import")!.value);
    const late = Number(measurand(samples.at(-1)!, "Power.Active.Import")!.value);
    expect(early).toBe(60_000);
    expect(late).toBe(48_000);
    const registers = samples.map((s) => Number(measurand(s, "Energy.Active.Import.Register")!.value));
    for (let i = 1; i < registers.length; i += 1) {
      expect(registers[i]!).toBeGreaterThan(registers[i - 1]!);
    }
    chargePoint.close();
  });

  it("AC2: no energy accrues while SuspendedEV", async () => {
    const { csms, chargePoint, calls } = setup({ ratedPowerKw: 7.4 });
    await chargePoint.announce();
    await remoteStart(csms);
    await chargePoint.setConnectorStatus("SuspendedEV");
    const before = chargePoint.getState().meterWh;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(chargePoint.getState().meterWh).toBe(before);
    const last = meterValues(calls).at(-1)!;
    expect(measurand(last, "Power.Active.Import")!.value).toBe("0");
    chargePoint.close();
  });

  it("AC3: meterStop is the register reading, with no +250 Wh", async () => {
    const { csms, chargePoint, calls } = setup({ ratedPowerKw: 7.4 });
    await chargePoint.announce();
    await remoteStart(csms);
    await vi.advanceTimersByTimeAsync(60_000);

    const lastRegister = Number(measurand(meterValues(calls).at(-1)!, "Energy.Active.Import.Register")!.value);
    await csms.call(Ocpp16Action.RemoteStopTransaction, { transactionId: 4242 });
    await vi.advanceTimersByTimeAsync(0);

    const stop = stops(calls)[0]!;
    // 7.4 kW × 60 s = 123.3 Wh
    expect(stop.payload["meterStop"]).toBe(1_123);
    expect(stop.payload["meterStop"]).toBe(lastRegister);
    expect(chargePoint.getState().meterWh).toBe(1_123);
    chargePoint.close();
  });

  it("AC4: defaults MeterValueSampleInterval to 30 s", async () => {
    const { csms, chargePoint } = setup();
    await chargePoint.announce();
    const got = await csms.call<{ configurationKey: Array<{ key: string; value: string }> }>(Ocpp16Action.GetConfiguration, {
      key: ["MeterValueSampleInterval"],
    });
    expect(got.configurationKey[0]?.value).toBe("30");
    chargePoint.close();
  });

  it("AC4: auto-stops after 15 minutes by default with reason Local", async () => {
    const { csms, chargePoint, calls } = setup({ ratedPowerKw: 7.4 });
    await chargePoint.announce();
    await remoteStart(csms);

    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1_000);
    expect(stops(calls)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);

    const all = stops(calls);
    expect(all).toHaveLength(1);
    expect(all[0]!.payload["reason"]).toBe("Local");
    // 7.4 kW × 15 min = 1850 Wh
    expect(all[0]!.payload["meterStop"]).toBe(2_850);
    expect(statuses(calls).slice(-2)).toEqual(["Finishing", "Available"]);
    const periodic = meterValues(calls).length - 1;
    expect(periodic).toBeGreaterThanOrEqual(29);

    const countAfterStop = meterValues(calls).length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(meterValues(calls)).toHaveLength(countAfterStop);
    chargePoint.close();
  });

  it("AC4: auto-stop minutes and sample interval are configurable; 0 disables auto-stop", async () => {
    const short = setup({ autoStopMinutes: 2, meterValueSampleInterval: 60 });
    await short.chargePoint.announce();
    await remoteStart(short.csms);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(stops(short.calls)).toHaveLength(1);
    expect(meterValues(short.calls).length).toBeGreaterThanOrEqual(2);
    short.chargePoint.close();

    const never = setup({ autoStopMinutes: 0 });
    await never.chargePoint.announce();
    await remoteStart(never.csms);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(stops(never.calls)).toHaveLength(0);
    never.chargePoint.close();
  });

  it("AC5: honours RemoteStop (e.g. the CSMS HOLD_LIMIT stop) and cancels the auto-stop", async () => {
    const { csms, chargePoint, calls } = setup({ ratedPowerKw: 22 });
    await chargePoint.announce();
    await remoteStart(csms);
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const res = await csms.call<{ status: string }>(Ocpp16Action.RemoteStopTransaction, { transactionId: 4242 });
    expect(res.status).toBe("Accepted");
    await vi.advanceTimersByTimeAsync(0);

    expect(stops(calls)).toHaveLength(1);
    expect(stops(calls)[0]!.payload["reason"]).toBe("Remote");
    expect(chargePoint.getState()).toMatchObject({ transactionId: null, connectorStatus: "Available" });

    const meterCount = meterValues(calls).length;
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(stops(calls)).toHaveLength(1);
    expect(meterValues(calls)).toHaveLength(meterCount);
    chargePoint.close();
  });

  it("AC5: rejects RemoteStop for another transaction id", async () => {
    const { csms, chargePoint, calls } = setup();
    await chargePoint.announce();
    await remoteStart(csms);
    const res = await csms.call<{ status: string }>(Ocpp16Action.RemoteStopTransaction, { transactionId: 9999 });
    expect(res.status).toBe("Rejected");
    expect(stops(calls)).toHaveLength(0);
    chargePoint.close();
  });

  it("AC5: a RemoteStop racing the auto-stop sends a single StopTransaction", async () => {
    const { csms, chargePoint, calls } = setup({ autoStopMinutes: 1 });
    await chargePoint.announce();
    await remoteStart(csms);
    await vi.advanceTimersByTimeAsync(60_000 - 1);
    const remote = csms.call(Ocpp16Action.RemoteStopTransaction, { transactionId: 4242 });
    await vi.advanceTimersByTimeAsync(1);
    await remote;
    await vi.advanceTimersByTimeAsync(10);
    expect(stops(calls)).toHaveLength(1);
    chargePoint.close();
  });

  it("resumes metering and keeps the auto-stop deadline after a reconnect", async () => {
    const initialState: ChargePointState = {
      transactionId: 4242,
      connectorStatus: "Charging",
      meterWh: 3_000,
      idTag: "TAG244",
      transactionStartedAt: T0.getTime() - 14 * 60_000,
    };
    const { chargePoint, calls } = setup({ initialState, ratedPowerKw: 7.4 });
    await chargePoint.announce();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(meterValues(calls).length).toBeGreaterThanOrEqual(1);
    expect(stops(calls)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);
    const all = stops(calls);
    expect(all).toHaveLength(1);
    expect(all[0]!.payload["reason"]).toBe("Local");
    // one minute at 7.4 kW = 123 Wh after the restored 3000 Wh
    expect(all[0]!.payload["meterStop"]).toBe(3_123);
    chargePoint.close();
  });

  it("finishes a stop cut off by a socket drop: one StopTransaction after reconnect with the saved meterStop and reason", async () => {
    const first = setup({ ratedPowerKw: 7.4 }, "Accepted", true);
    await first.chargePoint.announce();
    await remoteStart(first.csms);
    await vi.advanceTimersByTimeAsync(60_000);
    await first.csms.call(Ocpp16Action.RemoteStopTransaction, { transactionId: 4242 });
    await vi.advanceTimersByTimeAsync(0);
    // StopTransaction went out but was never acknowledged.
    expect(stops(first.calls)).toHaveLength(1);
    expect(stops(first.calls)[0]!.payload).toMatchObject({ meterStop: 1_123, reason: "Remote" });

    // Socket drops: the session saves state and drops the charge point (as OcppSession does).
    const saved = JSON.parse(JSON.stringify(first.chargePoint.getState())) as ChargePointState;
    first.chargePoint.close();
    expect(saved).toMatchObject({ transactionId: 4242, connectorStatus: "Finishing", meterWh: 1_123, pendingStopReason: "Remote" });

    // Time passes while offline; no energy may accrue while Finishing.
    vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
    const second = setup({ initialState: saved, ratedPowerKw: 7.4 });
    await second.chargePoint.announce();
    await vi.advanceTimersByTimeAsync(0);

    const resent = stops(second.calls);
    expect(resent).toHaveLength(1);
    expect(resent[0]!.payload).toMatchObject({ transactionId: 4242, meterStop: 1_123, reason: "Remote" });
    expect(second.chargePoint.getState()).toMatchObject({ transactionId: null, connectorStatus: "Available", pendingStopReason: null });

    // No auto-stop or second StopTransaction later, and a new RemoteStart is accepted.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(stops(second.calls)).toHaveLength(1);
    await remoteStart(second.csms);
    expect(second.chargePoint.getState().transactionId).toBe(4242);
    second.chargePoint.close();
  });

  it("finishes a restored Finishing stop with reason Local when no reason was saved", async () => {
    const initialState: ChargePointState = {
      transactionId: 4242,
      connectorStatus: "Finishing",
      meterWh: 2_000,
      idTag: "TAG244",
      transactionStartedAt: T0.getTime() - 5 * 60_000,
    };
    const { chargePoint, calls } = setup({ initialState });
    await chargePoint.announce();
    await vi.advanceTimersByTimeAsync(0);
    expect(stops(calls)).toHaveLength(1);
    expect(stops(calls)[0]!.payload).toMatchObject({ transactionId: 4242, meterStop: 2_000, reason: "Local" });
    expect(statuses(calls).at(-1)).toBe("Available");
    chargePoint.close();
  });

  it("keeps fractional Wh across a reconnect", async () => {
    const first = setup({ ratedPowerKw: 7.4, autoStopMinutes: 0 });
    await first.chargePoint.announce();
    await remoteStart(first.csms);
    // 7.4 kW × 30 s = 61.67 Wh
    await vi.advanceTimersByTimeAsync(30_000);
    const saved = JSON.parse(JSON.stringify(first.chargePoint.getState())) as ChargePointState;
    first.chargePoint.close();
    expect(saved.meterWh).toBe(1_061);
    expect(saved.meterWhExact).toBeCloseTo(1_061.6667, 3);

    const second = setup({ initialState: saved, ratedPowerKw: 7.4, autoStopMinutes: 0 });
    await second.chargePoint.announce();
    // Another 61.67 Wh: 1123.33 total, so 1123 (it would read 1122 if the 0.67 Wh were dropped).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(second.chargePoint.getState().meterWh).toBe(1_123);
    second.chargePoint.close();
  });
});
