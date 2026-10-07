import { Ocpp16Action, readString } from "@pratvoltix/ocpp";
import { assertDefined } from "@pratvoltix/test-runner";
import { defineTestCase } from "../definitions.js";
import type { OcppTestContext } from "../context.js";

export const firmwareDiagnosticsCase = defineTestCase<OcppTestContext>({
  id: "firmware-diagnostics",
  title: "UpdateFirmware and GetDiagnostics status notifications",
  description: "UpdateFirmware emits FirmwareStatusNotification progression; GetDiagnostics returns fileName and DiagnosticsStatusNotification.",
  version: "1.6",
  tags: ["firmware", "diagnostics", "csms-action"],
  timeoutMs: 30_000,
  async run(ctx) {
    const { callTimeoutMs, eventTimeoutMs } = ctx.profile.parameters;

    const firmwareStatuses: string[] = [];
    const firmwareDone = (async () => {
      for (const expected of ["Downloading", "Downloaded", "Installing", "Installed"]) {
        const call = await ctx.peer.waitFor(
          Ocpp16Action.FirmwareStatusNotification,
          eventTimeoutMs,
          (p) => readString(p, "status") === expected,
        );
        firmwareStatuses.push(expected);
        call.reply({});
      }
    })();

    await ctx.peer.call(Ocpp16Action.UpdateFirmware, {
      location: "https://example.invalid/fw.bin",
      retrieveDate: new Date().toISOString(),
    }, callTimeoutMs);
    await firmwareDone;
    ctx.log(`Firmware statuses: ${firmwareStatuses.join(" → ")}`);

    const diagStatuses: string[] = [];
    const diagDone = (async () => {
      for (const expected of ["Uploading", "Uploaded"]) {
        const call = await ctx.peer.waitFor(
          Ocpp16Action.DiagnosticsStatusNotification,
          eventTimeoutMs,
          (p) => readString(p, "status") === expected,
        );
        diagStatuses.push(expected);
        call.reply({});
      }
    })();

    const diagnostics = await ctx.peer.call<{ fileName?: string }>(
      Ocpp16Action.GetDiagnostics,
      { location: "ftp://example.invalid/diag/" },
      callTimeoutMs,
    );
    assertDefined(diagnostics.fileName, "GetDiagnostics should return fileName");
    await diagDone;
    ctx.log(`Diagnostics fileName=${diagnostics.fileName}; ${diagStatuses.join(" → ")}`);
  },
});
