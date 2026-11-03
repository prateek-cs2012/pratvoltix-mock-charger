import { describe, expect, it } from "vitest";
import {
  DEFAULT_AC_RATED_KW,
  DEFAULT_DC_RATED_KW,
  MeterModel,
  parseChargerType,
  parseNonNegativeNumber,
  parsePositiveNumber,
} from "./meter-model.js";

const MID = () => 0.5; // jitter factor exactly 1.0

describe("MeterModel (PRAT-244 AC2)", () => {
  it("integrates energy = kW × dt for an AC charger", () => {
    const meter = new MeterModel(1_000, { chargerType: "AC", ratedPowerKw: 7.4, random: MID });
    meter.advance(30_000, 30_000);
    // 7.4 kW × 30 s = 61.67 Wh
    expect(meter.registerWh).toBe(1_061);
    expect(meter.powerW).toBe(7_400);
  });

  it("keeps fractional Wh between ticks so short intervals are not lost", () => {
    const meter = new MeterModel(0, { chargerType: "AC", ratedPowerKw: 22, random: MID });
    for (let i = 1; i <= 30; i += 1) {
      meter.advance(30_000, i * 30_000);
    }
    // 22 kW × 15 min = 5.5 kWh
    expect(meter.registerWh).toBe(5_500);
    expect(Number.isInteger(meter.registerWh)).toBe(true);
  });

  it("applies slight AC jitter and never exceeds rated power", () => {
    const low = new MeterModel(0, { chargerType: "AC", ratedPowerKw: 22, random: () => 0 });
    const high = new MeterModel(0, { chargerType: "AC", ratedPowerKw: 22, random: () => 0.9999 });
    expect(low.samplePowerKw(0)).toBeCloseTo(22 * 0.99, 6);
    expect(high.samplePowerKw(0)).toBeLessThanOrEqual(22);
    expect(high.samplePowerKw(0)).toBeGreaterThan(21.9);
  });

  it("holds DC rated power early, then tapers to a floor", () => {
    const meter = new MeterModel(0, { chargerType: "DC", ratedPowerKw: 60, random: MID });
    expect(meter.samplePowerKw(5 * 60_000)).toBeCloseTo(60, 6);
    expect(meter.samplePowerKw(10 * 60_000)).toBeCloseTo(60, 6);
    expect(meter.samplePowerKw(20 * 60_000)).toBeCloseTo(48, 6);
    expect(meter.samplePowerKw(60 * 60_000)).toBeCloseTo(36, 6);
  });

  it("DC jitter stays within ±2% of target and below rated", () => {
    const meter = new MeterModel(0, { chargerType: "DC", ratedPowerKw: 30, random: () => 0 });
    expect(meter.samplePowerKw(0)).toBeCloseTo(30 * 0.98, 6);
    const highMeter = new MeterModel(0, { chargerType: "DC", ratedPowerKw: 30, random: () => 0.9999 });
    expect(highMeter.samplePowerKw(0)).toBeLessThanOrEqual(30);
  });

  it("defaults rated power by charger type and rejects invalid values", () => {
    expect(new MeterModel(0).ratedPowerKw).toBe(DEFAULT_AC_RATED_KW);
    expect(new MeterModel(0).chargerType).toBe("AC");
    expect(new MeterModel(0, { chargerType: "DC" }).ratedPowerKw).toBe(DEFAULT_DC_RATED_KW);
    expect(new MeterModel(0, { chargerType: "AC", ratedPowerKw: 0 }).ratedPowerKw).toBe(DEFAULT_AC_RATED_KW);
    expect(new MeterModel(0, { chargerType: "AC", ratedPowerKw: Number.NaN }).ratedPowerKw).toBe(DEFAULT_AC_RATED_KW);
    expect(new MeterModel(0, { chargerType: "AC", ratedPowerKw: 22 }).ratedPowerKw).toBe(22);
  });

  it("ignores zero or negative intervals and reports 0 W when idle", () => {
    const meter = new MeterModel(500, { ratedPowerKw: 7.4, random: MID });
    meter.advance(0, 0);
    meter.advance(-5, 0);
    expect(meter.registerWh).toBe(500);
    expect(meter.powerW).toBe(0);
    meter.begin();
    expect(meter.powerW).toBe(7_400);
    meter.idle();
    expect(meter.powerW).toBe(0);
  });
});

describe("meter env parsing", () => {
  it("parses charger type case-insensitively", () => {
    expect(parseChargerType("dc")).toBe("DC");
    expect(parseChargerType(" AC ")).toBe("AC");
    expect(parseChargerType("CCS2")).toBeUndefined();
    expect(parseChargerType(undefined)).toBeUndefined();
  });

  it("parses numbers", () => {
    expect(parsePositiveNumber("7.4")).toBe(7.4);
    expect(parsePositiveNumber("0")).toBeUndefined();
    expect(parsePositiveNumber("abc")).toBeUndefined();
    expect(parsePositiveNumber("")).toBeUndefined();
    expect(parseNonNegativeNumber("0")).toBe(0);
    expect(parseNonNegativeNumber("-1")).toBeUndefined();
    expect(parseNonNegativeNumber(undefined)).toBeUndefined();
  });
});
