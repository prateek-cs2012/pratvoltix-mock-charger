import { Ocpp16Action, readString } from "@pratvoltix/ocpp";
import { assertEqual } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";

export const changeAvailabilityCase = defineTestCase<OcppTestContext>({
  id: "change-availability",
  title: "ChangeAvailability Operative/Inoperative",
  description: "Sets connector Inoperative (Unavailable StatusNotification), then Operative (Available).",
  version: "1.6",
  tags: ["availability", "csms-action"],
  timeoutMs: 20_000,
  async run(ctx) {
    const { connectorId, callTimeoutMs, eventTimeoutMs } = ctx.profile.parameters;

    const unavailablePromise = ctx.peer.waitFor(
      Ocpp16Action.StatusNotification,
      eventTimeoutMs,
      (p) => readString(p, "status") === "Unavailable",
    );
    const inoperative = await ctx.peer.call<{ status: string }>(
      Ocpp16Action.ChangeAvailability,
      { connectorId, type: "Inoperative" },
      callTimeoutMs,
    );
    assertEqual(inoperative.status, "Accepted", "Inoperative should be Accepted when idle");
    const unavailable = await unavailablePromise;
    unavailable.reply({});
    ctx.log("Connector Unavailable");

    const availablePromise = ctx.peer.waitFor(
      Ocpp16Action.StatusNotification,
      eventTimeoutMs,
      (p) => readString(p, "status") === "Available",
    );
    const operative = await ctx.peer.call<{ status: string }>(
      Ocpp16Action.ChangeAvailability,
      { connectorId, type: "Operative" },
      callTimeoutMs,
    );
    assertEqual(operative.status, "Accepted", "Operative should be Accepted");
    const available = await availablePromise;
    available.reply({});
    ctx.log("Connector Available again");
  },
});
