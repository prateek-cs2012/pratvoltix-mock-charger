import { ControlProtocolError } from "@pratvoltix/simulator-control";
import { describe, expect, it } from "vitest";
import { FaultEngine } from "./fault-engine.js";
import { OcppSession, type OcppSocket } from "./ocpp-session.js";

class FakeSocket implements OcppSocket {
  protocol = "ocpp1.6";
  readyState = 0;
  sent: string[] = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void): void {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
  }

  once(event: "close", listener: () => void): void {
    const wrapped = () => {
      const current = this.listeners.get(event) ?? [];
      this.listeners.set(event, current.filter((entry) => entry !== wrapped));
      listener();
    };
    this.on(event, wrapped);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  receive(data: string): void {
    this.emit("message", data);
  }

  private emit(event: string, data?: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(data);
    }
  }
}

function sessionWith(sockets: FakeSocket[], notes: Array<{ action: string; payload: unknown }>) {
  let pending: FakeSocket | undefined;
  const session = new OcppSession({
    identity: "CP001",
    bootstrapUrl: "ws://api:8080/ocpp/CP001",
    faults: new FaultEngine(),
    notify: async (action, payload) => {
      notes.push({ action, payload });
      return { accepted: true };
    },
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      pending = socket;
      return socket;
    },
  });
  return {
    session,
    openLatest() {
      const socket = pending;
      if (!socket) {
        throw new Error("missing socket");
      }
      socket.open();
    },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("single OCPP socket", () => {
  it("closes the previous socket before opening the next target", async () => {
    const sockets: FakeSocket[] = [];
    const notes: Array<{ action: string; payload: unknown }> = [];
    const harness = sessionWith(sockets, notes);
    const first = harness.session.connect("ws://probe-a.example/independent/CP001?token=secret");
    await flush();
    harness.openLatest();
    await first;
    const order: string[] = [];
    const originalClose = sockets[0]!.close.bind(sockets[0]);
    sockets[0]!.close = () => {
      order.push("close-a");
      originalClose();
    };
    const second = harness.session.connect("ws://probe-b.example/independent/CP001");
    expect(order).toEqual(["close-a"]);
    expect(sockets[0]!.readyState).toBe(3);
    await flush();
    harness.openLatest();
    await second;
    expect(harness.session.activeSocketCount()).toBe(1);
    expect(sockets[1]!.readyState).toBe(1);
    expect(notes.some((note) => note.action === "connect-ocpp")).toBe(false);
    expect(notes.every((note) => note.action === "ocpp-state" || note.action === "ocpp-frame")).toBe(true);
    expect(JSON.stringify(notes)).not.toContain("secret");
  });

  it("mirrors OCPP frames and keeps control envelopes out of that stream", async () => {
    const sockets: FakeSocket[] = [];
    const notes: Array<{ action: string; payload: unknown }> = [];
    const harness = sessionWith(sockets, notes);
    const connected = harness.session.connect("ws://probe.example/independent/CP001");
    await flush();
    harness.openLatest();
    await connected;
    sockets[0]!.send("[2,\"1\",\"Heartbeat\",{}]");
    sockets[0]!.receive("[3,\"1\",{\"currentTime\":\"2026-10-06T00:00:00.000Z\"}]");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const frames = notes.filter((note) => note.action === "ocpp-frame");
    expect(frames.map((frame) => (frame.payload as { raw: string }).raw)).toContain("[2,\"1\",\"Heartbeat\",{}]");
    expect(frames.map((frame) => (frame.payload as { raw: string }).raw)).toContain("[3,\"1\",{\"currentTime\":\"2026-10-06T00:00:00.000Z\"}]");
    expect(frames.some((frame) => (frame.payload as { raw: string }).raw.includes("connect-ocpp"))).toBe(false);
    expect(notes.some((note) => note.action !== "ocpp-frame" && note.action !== "ocpp-state")).toBe(false);
  });

  it("does not restore the bootstrap socket when an external connect fails", async () => {
    const sockets: FakeSocket[] = [];
    const harness = sessionWith(sockets, []);
    const pending = harness.session.connect("ws://user:secret@unreachable.example/ocpp/CP001");
    await flush();
    sockets[0]!.close();
    await expect(pending).rejects.toBeInstanceOf(ControlProtocolError);
    await expect(pending).rejects.toThrow(/External CSMS connection failed/);
    await flush();
    expect(sockets).toHaveLength(1);
  });
});
