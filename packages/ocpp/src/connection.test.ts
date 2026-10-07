import { describe, expect, it } from "vitest";
import { OcppConnection, type OcppObservedFrame } from "./connection.js";
import { OcppCallError, OcppTimeoutError } from "./errors.js";
import { linkTransports } from "./transport.js";

function pair() {
  const transports = linkTransports();
  return {
    client: new OcppConnection(transports.left, { defaultTimeoutMs: 500 }),
    server: new OcppConnection(transports.right, { defaultTimeoutMs: 500 }),
  };
}

describe("OcppConnection", () => {
  it("correlates a call with its result", async () => {
    const { client, server } = pair();
    server.onCall(async (call) => {
      expect(call.action).toBe("Heartbeat");
      return { currentTime: "2026-10-05T12:00:00.000Z" };
    });

    const result = await client.call("Heartbeat", {});
    expect(result.currentTime).toBe("2026-10-05T12:00:00.000Z");
  });

  it("lets a waiter answer an inbound call before the default handler", async () => {
    const { client, server } = pair();
    server.onCall(() => ({ status: "Rejected" }));

    const observed = server.waitFor("BootNotification");
    const pending = client.call("BootNotification", { chargePointVendor: "Pratvoltix" });
    const call = await observed;
    call.reply({ status: "Accepted", currentTime: "2026-10-05T12:00:00.000Z", interval: 60 });
    await expect(pending).resolves.toMatchObject({ status: "Accepted", interval: 60 });
  });

  it("surfaces CALLERROR responses", async () => {
    const { client, server } = pair();
    server.onCall(() => {
      throw new Error("handler failed");
    });

    await expect(client.call("Reset", { type: "Soft" })).rejects.toBeInstanceOf(OcppCallError);
  });

  it("times out when nobody answers", async () => {
    const transports = linkTransports();
    const client = new OcppConnection(transports.left, { defaultTimeoutMs: 20 });
    await expect(client.call("Heartbeat", {}, 20)).rejects.toBeInstanceOf(OcppTimeoutError);
  });

  it("observes inbound and outbound frames and correlates CALLRESULT actions", async () => {
    const { client, server, clientFrames, serverFrames } = observedPair();
    server.onCall(() => ({ currentTime: "2026-10-05T12:00:00.000Z" }));

    await client.call("Heartbeat", {});

    expect(clientFrames.map(brief)).toEqual([
      ["outbound", "CALL", "Heartbeat"],
      ["inbound", "CALLRESULT", "Heartbeat"],
    ]);
    expect(serverFrames.map(brief)).toEqual([
      ["inbound", "CALL", "Heartbeat"],
      ["outbound", "CALLRESULT", "Heartbeat"],
    ]);
  });

  it("correlates CALLERROR responses with the original action", async () => {
    const { client, server, clientFrames, serverFrames } = observedPair();
    server.onCall(() => {
      throw new Error("handler failed");
    });

    await expect(client.call("Reset", { type: "Soft" })).rejects.toBeInstanceOf(OcppCallError);
    expect(clientFrames.map(brief)).toEqual([
      ["outbound", "CALL", "Reset"],
      ["inbound", "CALLERROR", "Reset"],
    ]);
    expect(serverFrames.at(-1)).toMatchObject({
      direction: "outbound",
      messageType: "CALLERROR",
      action: "Reset",
      errorCode: "InternalError",
    });
  });

  it("stops delivering frames after unsubscribe", async () => {
    const transports = linkTransports();
    const frames: OcppObservedFrame[] = [];
    const server = new OcppConnection(transports.right, { defaultTimeoutMs: 500 });
    const stop = server.observe((frame) => frames.push(frame));
    stop();
    server.onCall(() => ({ currentTime: "2026-10-05T12:00:00.000Z" }));
    const client = new OcppConnection(transports.left, { defaultTimeoutMs: 500 });

    await client.call("Heartbeat", {});
    expect(frames).toEqual([]);
  });

  it("keeps the session working when an observer throws", async () => {
    const transports = linkTransports();
    const errors: Error[] = [];
    const server = new OcppConnection(transports.right, {
      defaultTimeoutMs: 500,
      onProtocolError: (error) => errors.push(error),
    });
    server.observe(() => {
      throw new Error("observer failed");
    });
    server.onCall(() => ({ currentTime: "2026-10-05T12:00:00.000Z" }));
    const client = new OcppConnection(transports.left, { defaultTimeoutMs: 500 });

    await expect(client.call("Heartbeat", {})).resolves.toEqual({ currentTime: "2026-10-05T12:00:00.000Z" });
    transports.left.send("not-json");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(errors).toHaveLength(1);
    await expect(client.call("Heartbeat", {})).resolves.toEqual({ currentTime: "2026-10-05T12:00:00.000Z" });
  });

  it("records malformed frames as UNKNOWN without dropping later calls", async () => {
    const transports = linkTransports();
    const frames: OcppObservedFrame[] = [];
    const server = new OcppConnection(transports.right, { defaultTimeoutMs: 500 });
    server.observe((frame) => frames.push(frame));
    server.onCall(() => ({ status: "Accepted" }));
    transports.left.send("not-json");
    transports.left.send(JSON.stringify([2, "uid", { password: "secret" }]));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(frames[0]).toMatchObject({ direction: "inbound", messageType: "UNKNOWN", raw: "not-json" });
    expect(frames[1]).toMatchObject({
      direction: "inbound",
      messageType: "UNKNOWN",
      raw: JSON.stringify([2, "uid", { password: "secret" }]),
    });

    const client = new OcppConnection(transports.left, { defaultTimeoutMs: 500 });
    await expect(client.call("Heartbeat", {})).resolves.toEqual({ status: "Accepted" });
  });

  it("clears a timed-out call so a later result and the next call still work", async () => {
    const transports = linkTransports();
    const server = new OcppConnection(transports.right, { defaultTimeoutMs: 500 });
    const client = new OcppConnection(transports.left, { defaultTimeoutMs: 30 });
    let uniqueId = "";
    server.observe((frame) => {
      if (frame.direction === "inbound" && frame.messageType === "CALL" && frame.action === "GetConfiguration") {
        uniqueId = frame.uniqueId ?? "";
      }
    });
    server.onCall((call) => {
      if (call.action === "GetConfiguration") {
        return new Promise(() => undefined);
      }
      return { status: "Accepted" };
    });
    await expect(client.call("GetConfiguration", {}, 30)).rejects.toThrow(/Timed out waiting for GetConfiguration/);
    expect(uniqueId).not.toBe("");
    transports.right.send(JSON.stringify([3, uniqueId, { status: "Accepted" }]));
    await expect(client.call("Heartbeat", {})).resolves.toEqual({ status: "Accepted" });
  });
});

function observedPair() {
  const transports = linkTransports();
  const clientFrames: OcppObservedFrame[] = [];
  const serverFrames: OcppObservedFrame[] = [];
  const client = new OcppConnection(transports.left, { defaultTimeoutMs: 500 });
  const server = new OcppConnection(transports.right, { defaultTimeoutMs: 500 });
  client.observe((frame) => clientFrames.push(frame));
  server.observe((frame) => serverFrames.push(frame));
  return { client, server, clientFrames, serverFrames };
}

function brief(frame: OcppObservedFrame): [string, string, string | undefined] {
  return [frame.direction, frame.messageType, frame.action];
}
