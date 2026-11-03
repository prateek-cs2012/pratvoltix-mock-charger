/**
 * Meter model for the mock charge point (PRAT-244).
 *
 * Energy is integrated from power over time: energyWh += kW × dt(h) × 1000.
 * AC chargers deliver close to their rated power with slight jitter. DC chargers
 * deliver close to their rated power for the first minutes and then taper, as a
 * real DC session does once the battery fills. No SoC is modelled on purpose:
 * the CSMS stops a session when it sees SoC >= 100.
 */

export type ChargerType = "AC" | "DC";

export const DEFAULT_AC_RATED_KW = 7.4;
export const DEFAULT_DC_RATED_KW = 60;

/** Relative jitter applied to every power sample (± fraction of the target). */
export const AC_JITTER = 0.01;
export const DC_JITTER = 0.02;
/** DC holds full power for this long, then tapers linearly. */
export const DC_TAPER_START_MS = 10 * 60_000;
/** DC power falls by this fraction of rated per minute once tapering. */
export const DC_TAPER_PER_MINUTE = 0.02;
/** DC power never tapers below this fraction of rated. */
export const DC_TAPER_FLOOR = 0.6;

const REGISTER_EPSILON_WH = 1e-6;

export interface MeterModelOptions {
  /** "AC" or "DC", case-insensitive; anything else falls back to AC. */
  chargerType?: ChargerType | string;
  ratedPowerKw?: number;
  /** Random source in [0, 1). Injected by tests for deterministic jitter. */
  random?: () => number;
}

export function parseChargerType(value: string | undefined): ChargerType | undefined {
  if (!value) {
    return undefined;
  }
  const upper = value.trim().toUpperCase();
  return upper === "AC" || upper === "DC" ? upper : undefined;
}

export function parsePositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseNonNegativeNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export class MeterModel {
  readonly chargerType: ChargerType;
  readonly ratedPowerKw: number;
  private readonly random: () => number;
  /** Fractional energy so short ticks are not lost to integer rounding. */
  private energyWh: number;
  private lastPowerW = 0;

  constructor(startWh: number, options: MeterModelOptions = {}) {
    // Normalise so "dc" gets the DC profile and the DC default power, not the DC taper with AC power.
    this.chargerType = parseChargerType(options.chargerType) ?? "AC";
    const fallback = this.chargerType === "DC" ? DEFAULT_DC_RATED_KW : DEFAULT_AC_RATED_KW;
    const rated = options.ratedPowerKw;
    this.ratedPowerKw = typeof rated === "number" && Number.isFinite(rated) && rated > 0 ? rated : fallback;
    this.random = options.random ?? Math.random;
    this.energyWh = Number.isFinite(startWh) ? Math.max(0, startWh) : 0;
  }

  /** Exact (fractional) energy in Wh, persisted so a reconnect does not drop the partial Wh. */
  get energyWhExact(): number {
    return this.energyWh;
  }

  /** Energy.Active.Import.Register as an integer in Wh. */
  get registerWh(): number {
    // Small epsilon so float error (5499.9999…) does not drop a whole Wh.
    return Math.floor(this.energyWh + REGISTER_EPSILON_WH);
  }

  /** Power.Active.Import of the last charging interval, in W (0 when idle). */
  get powerW(): number {
    return this.lastPowerW;
  }

  /** Target power in kW at a point in the session, before jitter. */
  targetPowerKw(elapsedMs: number): number {
    if (this.chargerType === "AC") {
      return this.ratedPowerKw;
    }
    if (elapsedMs <= DC_TAPER_START_MS) {
      return this.ratedPowerKw;
    }
    const taperMinutes = (elapsedMs - DC_TAPER_START_MS) / 60_000;
    const fraction = Math.max(DC_TAPER_FLOOR, 1 - DC_TAPER_PER_MINUTE * taperMinutes);
    return this.ratedPowerKw * fraction;
  }

  /**
   * Power in kW with jitter. Never above rated power: jitter that would go above rated is
   * reflected below it, so at full power the samples spread below rated instead of being
   * clipped to exactly rated.
   */
  samplePowerKw(elapsedMs: number): number {
    const jitter = this.chargerType === "AC" ? AC_JITTER : DC_JITTER;
    const factor = 1 - jitter + 2 * jitter * this.random();
    const kw = this.targetPowerKw(elapsedMs) * factor;
    const belowRated = kw > this.ratedPowerKw ? 2 * this.ratedPowerKw - kw : kw;
    return Math.max(0, belowRated);
  }

  /**
   * Integrate one interval of charging: energy = kW × dt.
   * `elapsedMs` is time since the transaction started, at the end of the interval.
   */
  advance(dtMs: number, elapsedMs: number): void {
    if (!(dtMs > 0)) {
      return;
    }
    const kw = this.samplePowerKw(elapsedMs);
    this.lastPowerW = Math.round(kw * 1000);
    this.energyWh += (kw * 1000 * dtMs) / 3_600_000;
  }

  /** Power flows from the start of a transaction, so the Begin sample shows it. */
  begin(): void {
    this.lastPowerW = Math.round(this.samplePowerKw(0) * 1000);
  }

  /** Mark the meter idle (no power flowing) without changing the register. */
  idle(): void {
    this.lastPowerW = 0;
  }
}
