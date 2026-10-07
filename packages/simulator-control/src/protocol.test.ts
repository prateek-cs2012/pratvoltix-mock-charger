import { describe, expect, it } from "vitest";
import { ControlProtocolError } from "./errors.js";
import { MAX_DELAY_MS, validateFaultRule } from "./faults.js";
import { CONTROL_PROTOCOL_VERSION, ControlChannel, parseControlMessage, validateHello } from "./protocol.js";

describe("control messages", () => {
  it("rejects malformed messages and unsupported actions", () => {
    expect(() => parseControlMessage("not-json")).toThrow(ControlProtocolError);
    expect(() => parseControlMessage(JSON.stringify({ type: "request", requestId: "abc", action: "reboot", payload: {} }))).toThrow(
      /Unsupported control action/,
    );
  });

  it("rejects an incompatible hello version", () => {
    expect(() =>
      validateHello({
        protocolVersion: "9",
        chargePointIdentity: "CP001",
        simulatorName: "Mock",
        simulatorVersion: "0.1.0",
        capabilities: ["simulator-control"],
      }),
    ).toThrow(/Unsupported control protocol version "9"/);
    expect(
      validateHello({
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        chargePointIdentity: "CP001",
        simulatorName: "Mock",
        simulatorVersion: "0.1.0",
        capabilities: ["simulator-control"],
      }).chargePointIdentity,
    ).toBe("CP001");
  });

  it("correlates a response with its request", async () => {
    const peer = paired();
    peer.right.onRequest = async (request) => ({ seen: request.action });
    await expect(peer.left.request("get-status", {})).resolves.toEqual({ seen: "get-status" });
  });

  it("times out a request that never receives a response", async () => {
    const peer = paired();
    peer.right.hold = true;
    await expect(peer.left.request("get-status", {}, 20)).rejects.toMatchObject({ code: "timeout" });
  });

  it("fails pending requests when the channel closes", async () => {
    const peer = paired();
    peer.right.hold = true;
    const pending = peer.left.request("list-faults", {});
    peer.left.close();
    await expect(pending).rejects.toMatchObject({ code: "disconnected" });
  });

  it("rejects a duplicate request id while the first is pending", async () => {
    const sent: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const channel = new ControlChannel(
      (text) => sent.push(text),
      {
        onRequest: async () => {
          await gate;
          return { ok: true };
        },
      },
    );
    channel.handleRaw(JSON.stringify({ type: "request", requestId: "same", action: "get-status", payload: {} }));
    channel.handleRaw(JSON.stringify({ type: "request", requestId: "same", action: "get-status", payload: {} }));
    const duplicate = JSON.parse(sent.at(-1) ?? "{}") as { ok?: boolean; error?: { code?: string } };
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error?.code).toBe("duplicate-request");
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("bounds the number of pending requests", async () => {
    const peer = paired(1);
    peer.right.hold = true;
    const first = peer.left.request("get-status", {});
    await expect(peer.left.request("list-faults", {})).rejects.toMatchObject({ code: "too-many-requests" });
    peer.left.close();
    await expect(first).rejects.toMatchObject({ code: "disconnected" });
  });
});

describe("fault rules", () => {
  it("rejects duplicate-looking invalid rules and unbounded delays", () => {
    expect(() => validateFaultRule({ id: "ok", consume: "once", match: { action: "Reset" }, effect: { type: "delay", delayMs: MAX_DELAY_MS + 1 } })).toThrow(
      /delayMs/,
    );
    expect(() =>
      validateFaultRule({
        id: "ok",
        consume: "once",
        match: { action: "Reset" },
        effect: { type: "call-result", payload: ["nope"] },
      }),
    ).toThrow(/JSON object/);
    const rule = validateFaultRule({
      id: "reset-once",
      consume: "once",
      match: { action: "Reset" },
      effect: { type: "call-error", errorCode: "InternalError", description: "boom", details: { nested: true } },
    });
    expect(rule.match.occurrence).toBe(1);
    expect(rule.effect).toMatchObject({ type: "call-error", errorCode: "InternalError" });
  });
});

function paired(maxPending = 8) {
  const leftSend: { current: (text: string) => void } = { current: () => undefined };
  const rightSend: { current: (text: string) => void } = { current: () => undefined };
  const rightState: { hold: boolean; onRequest?: (request: { action: string }) => Promise<unknown> } = { hold: false };
  const left = new ControlChannel((text) => rightSend.current(text), { maxPending });
  const right = new ControlChannel((text) => leftSend.current(text), {
    onRequest: async (request) => {
      if (rightState.hold) {
        return new Promise(() => undefined);
      }
      return rightState.onRequest?.(request);
    },
  });
  leftSend.current = (text) => left.handleRaw(text);
  rightSend.current = (text) => right.handleRaw(text);
  return {
    left,
    get right() {
      return rightState;
    },
  };
}
