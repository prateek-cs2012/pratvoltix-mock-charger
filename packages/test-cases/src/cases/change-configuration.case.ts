import { Ocpp16Action } from "@pratvoltix/ocpp";
import { AssertionError, assertEqual } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";

export const changeConfigurationCase = defineTestCase<OcppTestContext>({
  id: "change-configuration",
  title: "ChangeConfiguration",
  description: "Read a configuration key, apply the temporary test value, verify it, and restore the original value.",
  version: "1.6",
  tags: ["configuration"],
  timeoutMs: 15_000,
  async run(ctx) {
    const { configurationKey, configurationTestValue, callTimeoutMs } = ctx.profile.parameters;
    let original: string | undefined;
    let changed = false;
    let failure: unknown;

    try {
      original = await readKey(ctx, configurationKey, callTimeoutMs);
      const changedResponse = await ctx.peer.call<{ status: string }>(
        Ocpp16Action.ChangeConfiguration,
        { key: configurationKey, value: configurationTestValue },
        callTimeoutMs,
      );
      if (changedResponse.status === "NotSupported" || changedResponse.status === "Rejected") {
        throw new AssertionError(
          `ChangeConfiguration for ${configurationKey} returned ${changedResponse.status}. The key is read-only or unsupported, so the test did not leave a new value.`,
        );
      }
      if (changedResponse.status !== "Accepted" && changedResponse.status !== "RebootRequired") {
        throw new AssertionError(
          `ChangeConfiguration for ${configurationKey} returned ${changedResponse.status}. Expected Accepted or RebootRequired.`,
        );
      }
      changed = true;
      const readBack = await readKey(ctx, configurationKey, callTimeoutMs);
      assertEqual(readBack, configurationTestValue, `${configurationKey} should read back as the configured test value`);
    } catch (error) {
      failure = error;
    }

    if (changed && original !== undefined) {
      try {
        const restored = await ctx.peer.call<{ status: string }>(
          Ocpp16Action.ChangeConfiguration,
          { key: configurationKey, value: original },
          callTimeoutMs,
        );
        if (restored.status !== "Accepted" && restored.status !== "RebootRequired") {
          throw new Error(`restore returned ${restored.status}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "restore failed";
        if (failure instanceof Error) {
          failure.message = `${failure.message} (configuration restore failed: ${message})`;
        } else if (failure !== undefined) {
          failure = new Error(`${String(failure)} (configuration restore failed: ${message})`);
        } else {
          failure = new Error(`Configuration restore failed for ${configurationKey}: ${message}`);
        }
      }
    }

    if (failure !== undefined) {
      throw failure;
    }
    ctx.log(`${configurationKey} changed to ${configurationTestValue} and restored to ${original}`);
  },
});

async function readKey(ctx: OcppTestContext, key: string, timeoutMs: number): Promise<string> {
  const response = await ctx.peer.call<{ configurationKey?: Array<{ key?: string; value?: string }> }>(
    Ocpp16Action.GetConfiguration,
    { key: [key] },
    timeoutMs,
  );
  const entry = response.configurationKey?.find((item) => item.key === key);
  if (typeof entry?.value !== "string" || entry.value.length === 0) {
    throw new AssertionError(`GetConfiguration did not return a value for ${key}.`);
  }
  return entry.value;
}
