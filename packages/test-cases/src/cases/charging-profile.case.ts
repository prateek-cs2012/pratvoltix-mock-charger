import { Ocpp16Action } from "@pratvoltix/ocpp";
import { assertEqual } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";

export const chargingProfileCase = defineTestCase<OcppTestContext>({
  id: "charging-profile",
  title: "Set/ClearChargingProfile and GetCompositeSchedule",
  description: "Accepts a TxDefaultProfile, returns a composite schedule, then clears profiles.",
  version: "1.6",
  tags: ["charging-profile", "csms-action"],
  timeoutMs: 20_000,
  async run(ctx) {
    const { connectorId, callTimeoutMs } = ctx.profile.parameters;

    const set = await ctx.peer.call<{ status: string }>(
      Ocpp16Action.SetChargingProfile,
      {
        connectorId,
        csChargingProfiles: {
          chargingProfileId: 1,
          stackLevel: 0,
          chargingProfilePurpose: "TxDefaultProfile",
          chargingProfileKind: "Absolute",
          chargingSchedule: {
            chargingRateUnit: "A",
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 16 }],
          },
        },
      },
      callTimeoutMs,
    );
    assertEqual(set.status, "Accepted", "SetChargingProfile should be Accepted");

    const schedule = await ctx.peer.call<{ status: string; connectorId?: number }>(
      Ocpp16Action.GetCompositeSchedule,
      { connectorId, duration: 600 },
      callTimeoutMs,
    );
    assertEqual(schedule.status, "Accepted", "GetCompositeSchedule should be Accepted");

    const cleared = await ctx.peer.call<{ status: string }>(
      Ocpp16Action.ClearChargingProfile,
      { chargingProfilePurpose: "TxDefaultProfile" },
      callTimeoutMs,
    );
    assertEqual(cleared.status, "Accepted", "ClearChargingProfile should be Accepted");
    ctx.log("Charging profile set/schedule/clear path complete");
  },
});
