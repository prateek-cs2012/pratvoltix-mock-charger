import { Ocpp16Action } from "@pratvoltix/ocpp";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { assertEqual } from "@pratvoltix/test-runner";
import { requireSimulator, type OcppTestContext } from "../context.js";
import { defineTestCase } from "../definitions.js";
import { withFault } from "../with-fault.js";

export const remoteStartRejectedCase = defineTestCase<OcppTestContext>({
  id: "remote-start-rejected",
  title: "Remote start rejected",
  description: "A one-shot CALLRESULT override makes RemoteStartTransaction return Rejected.",
  version: "1.6",
  tags: ["negative", "simulator"],
  requirements: [SIMULATOR_CAPABILITY],
  deployment: "adapter-required",
  timeoutMs: 15_000,
  async run(ctx) {
    await withFault(
      requireSimulator(ctx),
      {
        id: "remote-start-rejected",
        match: { action: Ocpp16Action.RemoteStartTransaction, occurrence: 1 },
        effect: { type: "call-result", payload: { status: "Rejected" } },
        consume: "once",
      },
      async () => {
        const response = await ctx.peer.call<{ status: string }>(
          Ocpp16Action.RemoteStartTransaction,
          { idTag: ctx.profile.parameters.idTag },
          ctx.profile.parameters.callTimeoutMs,
        );
        assertEqual(response.status, "Rejected", "Remote start should be rejected by the injected result");
      },
    );
  },
});
