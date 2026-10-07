import { Ocpp16Action } from "@pratvoltix/ocpp";
import { assertEqual } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";

export const softResetCase = defineTestCase<OcppTestContext>({
  id: "soft-reset",
  title: "Soft reset",
  description: "Request a soft reset and expect the charge point to accept it.",
  version: "1.6",
  tags: ["maintenance"],
  timeoutMs: 15_000,
  async run(ctx) {
    const response = await ctx.peer.call<{ status: string }>(
      Ocpp16Action.Reset,
      { type: "Soft" },
      ctx.profile.parameters.callTimeoutMs,
    );
    assertEqual(response.status, "Accepted", "Soft reset should be accepted");
    ctx.log("Soft reset accepted");
  },
});
