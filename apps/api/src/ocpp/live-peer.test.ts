import { Ocpp16Action, OcppConnection, linkTransports } from "@pratvoltix/ocpp";
import { describe, expect, it } from "vitest";
import { createLivePeer } from "./live-peer.js";
import { SessionRegistry } from "./registry.js";

describe("createLivePeer", () => {
  it("captures BootNotification across Soft Reset-style connection replace", async () => {
    const registry = new SessionRegistry();
    const peer = createLivePeer(registry, "CP001");

    const first = linkTransports();
    const firstConn = new OcppConnection(first.left);
    firstConn.onCall(async () => ({ status: "Accepted", currentTime: new Date().toISOString(), interval: 300 }));
    registry.replace({ identity: "CP001", connection: firstConn, transactionCounter: 0 });

    const bootPromise = peer.waitFor(Ocpp16Action.BootNotification, 5_000);

    // Simulate Soft Reset: new socket accepted before old is torn down (registry.replace order).
    const second = linkTransports();
    const secondConn = new OcppConnection(second.left);
    secondConn.onCall(async () => ({ status: "Accepted", currentTime: new Date().toISOString(), interval: 300 }));
    registry.replace({ identity: "CP001", connection: secondConn, transactionCounter: 0 });

    const cp = new OcppConnection(second.right);
    void cp.call(Ocpp16Action.BootNotification, {
      chargePointVendor: "Pratvoltix",
      chargePointModel: "Lab-One",
    });

    const boot = await bootPromise;
    expect(boot.action).toBe(Ocpp16Action.BootNotification);
    boot.reply({ status: "Accepted", currentTime: new Date().toISOString(), interval: 300 });
  });
});
