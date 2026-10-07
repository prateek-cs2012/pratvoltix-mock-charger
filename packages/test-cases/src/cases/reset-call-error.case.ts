import { Ocpp16Action, OcppCallError } from "@pratvoltix/ocpp";
import { SIMULATOR_CAPABILITY } from "@pratvoltix/simulator-control";
import { AssertionError, assertEqual } from "@pratvoltix/test-runner";
import { requireSimulator, type OcppTestContext } from "../context.js";
import { defineTestCase } from "../definitions.js";
import { withFault } from "../with-fault.js";

const ERROR_CODE = "InternalError";
const ERROR_DESCRIPTION = "Injected reset failure";

export const resetCallErrorCase = defineTestCase<OcppTestContext>({
  id: "reset-call-error",
  title: "Reset CALLERROR",
  description: "A one-shot CALLERROR makes Reset fail with InternalError.",
  version: "1.6",
  tags: ["negative", "simulator"],
  requirements: [SIMULATOR_CAPABILITY],
  deployment: "adapter-required",
  timeoutMs: 15_000,
  async run(ctx) {
    await withFault(
      requireSimulator(ctx),
      {
        id: "reset-call-error",
        match: { action: Ocpp16Action.Reset, occurrence: 1 },
        effect: { type: "call-error", errorCode: ERROR_CODE, description: ERROR_DESCRIPTION },
        consume: "once",
      },
      async () => {
        try {
          await ctx.peer.call(Ocpp16Action.Reset, { type: "Soft" }, ctx.profile.parameters.callTimeoutMs);
        } catch (error) {
          if (!(error instanceof OcppCallError)) {
            throw error;
          }
          assertEqual(error.errorCode, ERROR_CODE, "Reset error code should match the injected fault");
          assertEqual(error.errorDescription, ERROR_DESCRIPTION, "Reset error description should match the injected fault");
          return;
        }
        throw new AssertionError("Reset should fail with a CALLERROR");
      },
    );
  },
});
