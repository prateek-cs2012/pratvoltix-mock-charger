import { Ocpp16Action, readString } from "@pratvoltix/ocpp";
import { assertEqual } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";

export const reserveNowCase = defineTestCase<OcppTestContext>({
  id: "reserve-now",
  title: "ReserveNow and CancelReservation",
  description: "Reserves an idle connector (Reserved status), then cancels back to Available.",
  version: "1.6",
  tags: ["reservation", "csms-action"],
  timeoutMs: 20_000,
  async run(ctx) {
    const { connectorId, idTag, callTimeoutMs, eventTimeoutMs } = ctx.profile.parameters;
    const reservationId = 77;
    const expiryDate = new Date(Date.now() + 3_600_000).toISOString();

    const reservedPromise = ctx.peer.waitFor(
      Ocpp16Action.StatusNotification,
      eventTimeoutMs,
      (p) => readString(p, "status") === "Reserved",
    );
    const reserved = await ctx.peer.call<{ status: string }>(
      Ocpp16Action.ReserveNow,
      { connectorId, expiryDate, idTag, reservationId },
      callTimeoutMs,
    );
    assertEqual(reserved.status, "Accepted", "ReserveNow should be Accepted on idle connector");
    const reservedStatus = await reservedPromise;
    reservedStatus.reply({});
    ctx.log("Connector Reserved");

    const availablePromise = ctx.peer.waitFor(
      Ocpp16Action.StatusNotification,
      eventTimeoutMs,
      (p) => readString(p, "status") === "Available",
    );
    const cancelled = await ctx.peer.call<{ status: string }>(
      Ocpp16Action.CancelReservation,
      { reservationId },
      callTimeoutMs,
    );
    assertEqual(cancelled.status, "Accepted", "CancelReservation should be Accepted");
    const available = await availablePromise;
    available.reply({});
    ctx.log("Reservation cancelled");
  },
});
