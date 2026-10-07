import { Ocpp16Action, readNumber, readString } from "@pratvoltix/ocpp";
import { assertDefined, assertEqual } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";

export const statusNotificationCase = defineTestCase<OcppTestContext>({
  id: "status-notification",
  title: "StatusNotification",
  description: "Trigger a StatusNotification for the configured connector and require connector status.",
  version: "1.6",
  tags: ["core", "trigger"],
  deployment: "external-compatible",
  timeoutMs: 15_000,
  async run(ctx) {
    const timeouts = ctx.profile.parameters;
    const connectorId = timeouts.connectorId;
    const incoming = ctx.peer.waitFor(Ocpp16Action.StatusNotification, timeouts.eventTimeoutMs);
    const trigger = await ctx.peer.call<{ status: string }>(
      Ocpp16Action.TriggerMessage,
      { requestedMessage: Ocpp16Action.StatusNotification, connectorId },
      timeouts.callTimeoutMs,
    );
    assertEqual(trigger.status, "Accepted", "TriggerMessage should be accepted");
    const status = await incoming;
    assertEqual(readNumber(status.payload, "connectorId"), connectorId, "StatusNotification connectorId should match the profile");
    const connectorStatus = readString(status.payload, "status");
    assertDefined(connectorStatus, "status is required");
    assertEqual(readString(status.payload, "errorCode"), "NoError", "errorCode should be NoError");
    ctx.log(`Connector ${connectorId} status ${connectorStatus}`);
    status.reply({});
  },
});
