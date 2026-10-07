import { describe, expect, it, vi } from "vitest";
import { ExternalOcppSession } from "./external-peer.js";
import { executeExternalRun } from "./external-run.js";

describe("external OCPP session", () => {
  it("correlates mirrored charger calls and drops control envelopes", async () => {
    const emit = vi.fn(async () => ({ status: "Accepted" as const }));
    const session = new ExternalOcppSession(emit);
    const traced: string[] = [];
    session.observe((frame) => {
      if (frame.action) {
        traced.push(frame.action);
      }
    });
    expect(session.ingest({
      direction: "charge-point-to-csms",
      raw: JSON.stringify({ type: "request", requestId: "abc", action: "connect-ocpp", payload: { url: "ws://secret" } }),
    })).toBe(false);
    const waiting = session.waitFor("BootNotification", 1_000);
    session.ingest({
      direction: "charge-point-to-csms",
      raw: "[2,\"boot-1\",\"BootNotification\",{\"chargePointVendor\":\"Pratvoltix\",\"chargePointModel\":\"Lab-One\"}]",
    });
    const call = await waiting;
    expect(call.payload["chargePointVendor"]).toBe("Pratvoltix");
    await call.reply({});
    const accepted = await session.call<{ status: string }>("TriggerMessage", { requestedMessage: "Heartbeat" });
    expect(accepted.status).toBe("Accepted");
    expect(emit).toHaveBeenCalledWith("Heartbeat", undefined);
    expect(traced).toEqual(["BootNotification"]);
    await expect(session.call("Reset", { type: "Soft" })).rejects.toThrow(/charger-originated/);
  });
});

describe("external run failures", () => {
  it("does not execute cases or fall back when the external target is unreachable", async () => {
    const run = vi.fn();
    const restore = vi.fn(async () => undefined);
    const outcome = await executeExternalRun({
      connect: async () => {
        throw new Error("connect ECONNREFUSED ws://user:secret@10.1.1.1/independent/CP001?token=secret");
      },
      run,
      restore,
    });
    expect(run).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledOnce();
    expect(outcome.negotiatedSubprotocol).toBeNull();
    expect(outcome.error).toBe("External CSMS connection failed.");
    expect(outcome.error).not.toContain("secret");
  });

  it("runs only after ocpp1.6 is negotiated and still restores the idle target", async () => {
    const run = vi.fn(async () => undefined);
    const restore = vi.fn(async () => undefined);
    const outcome = await executeExternalRun({
      connect: async () => ({ subprotocol: "ocpp1.6" }),
      run,
      restore,
    });
    expect(outcome).toEqual({ negotiatedSubprotocol: "ocpp1.6" });
    expect(run).toHaveBeenCalledWith("ocpp1.6");
    expect(restore).toHaveBeenCalledOnce();
  });
});
