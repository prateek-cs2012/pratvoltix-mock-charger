import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OcppConnection, linkTransports } from "@pratvoltix/ocpp";
import type { OcppFrameObserver, OcppObservedFrame } from "@pratvoltix/ocpp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { presentRun } from "./runs.js";
import { SessionRegistry } from "./ocpp/registry.js";
import { RunTraceCollector, type FrameSource } from "./trace-collector.js";
import { presentTrace, readTraceFilter, readTracePage } from "./trace-query.js";
import { redactRaw, redactValue } from "./trace-redact.js";
import type { TestRunRecord } from "./models/test-run.js";
import type { TraceEntry } from "./trace-types.js";

const findById = vi.hoisted(() => vi.fn());

vi.mock("./models/test-run.js", () => ({
  TestRunModel: {
    findById,
  },
}));

describe("redaction", () => {
  it("redacts nested objects and arrays without mutating the input", () => {
    const payload = {
      password: "hunter2",
      nested: { AuthorizationKey: "key-1", name: "meter" },
      items: [{ token: "tok", apiKey: "api", secret: "s", idTag: "abc" }],
    };
    const original = structuredClone(payload);
    expect(redactValue(payload)).toEqual({
      password: "[REDACTED]",
      nested: { AuthorizationKey: "[REDACTED]", name: "meter" },
      items: [{ token: "[REDACTED]", apiKey: "[REDACTED]", secret: "[REDACTED]", idTag: "abc" }],
    });
    expect(payload).toEqual(original);
  });

  it("redacts JSON raw by re-serializing and scrubs secret literals in non-JSON text", () => {
    const raw = '[2, "u1", "Authorize", {"password": "hunter2"}]';
    const redacted = redactRaw(raw);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toBe(raw);

    const opaque = 'vendor-frame "token": "super-secret" tail';
    expect(redactRaw(opaque)).toBe('vendor-frame "token":"[REDACTED]" tail');
    expect(redactRaw(opaque)).not.toContain("super-secret");
  });
});

describe("RunTraceCollector", () => {
  it("associates frames with the active case and leaves gaps between cases unlabeled", () => {
    const source = fakeSource();
    const collector = new RunTraceCollector(source);
    collector.start();
    source.emit(callFrame("before"));
    collector.setActiveCase("heartbeat");
    source.emit(callFrame("during"));
    collector.setActiveCase(undefined);
    source.emit(callFrame("after"));
    collector.stop();
    source.emit(callFrame("ignored"));

    const entries = collector.snapshot().entries;
    expect(entries.map((entry) => entry.caseId)).toEqual([undefined, "heartbeat", undefined]);
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(entries.every((entry) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.at))).toBe(true);
    expect(entries[0]?.direction).toBe("charge-point-to-csms");
  });

  it("redacts payloads and raw frames but leaves the live protocol payload intact", async () => {
    const transports = linkTransports();
    const server = new OcppConnection(transports.right, { defaultTimeoutMs: 500 });
    const collector = new RunTraceCollector(server);
    collector.start();
    let seenPassword = "";
    server.onCall((call) => {
      seenPassword = String(call.payload.password);
      return { token: "live-token", status: "Accepted" };
    });
    const client = new OcppConnection(transports.left, { defaultTimeoutMs: 500 });

    await expect(client.call("Authorize", { idTag: "abc", password: "hunter2" })).resolves.toEqual({
      token: "live-token",
      status: "Accepted",
    });

    expect(seenPassword).toBe("hunter2");
    const snapshot = collector.snapshot();
    const stored = JSON.stringify(snapshot);
    expect(stored).not.toContain("hunter2");
    expect(stored).not.toContain("live-token");
    expect(stored).toContain("[REDACTED]");
    expect(snapshot.entries.map((entry) => entry.direction)).toEqual([
      "charge-point-to-csms",
      "csms-to-charge-point",
    ]);
    collector.stop();
  });

  it("records injected results, errors, delays, and unanswered calls without control traffic", async () => {
    const transports = linkTransports();
    const server = new OcppConnection(transports.right, { defaultTimeoutMs: 500 });
    const client = new OcppConnection(transports.left, { defaultTimeoutMs: 80 });
    const collector = new RunTraceCollector(server);
    collector.start();
    collector.setActiveCase("reset-call-error");
    server.onCall(async (call) => {
      if (call.action === "Reset") {
        throw Object.assign(new Error("Injected reset failure"), { errorCode: "InternalError", details: {} });
      }
      if (call.action === "GetConfiguration") {
        return new Promise(() => undefined);
      }
      if (call.action === "TriggerMessage") {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (call.action === "RemoteStartTransaction") {
        return { status: "Rejected" };
      }
      return {};
    });

    await expect(client.call("RemoteStartTransaction", { idTag: "TAG1" })).resolves.toEqual({ status: "Rejected" });
    collector.setActiveCase("reset-call-error");
    await expect(client.call("Reset", { type: "Soft" })).rejects.toThrow();
    collector.setActiveCase("get-configuration-timeout");
    await expect(client.call("GetConfiguration", {}, 40)).rejects.toThrow(/Timed out/);
    collector.setActiveCase("delayed-trigger-heartbeat");
    await expect(client.call("TriggerMessage", { requestedMessage: "Heartbeat" })).resolves.toEqual({});

    const entries = collector.snapshot().entries;
    expect(entries.every((entry) => entry.caseId)).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("arm-fault");
    expect(JSON.stringify(entries)).not.toContain("pratvoltix-lab-control");
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageType: "CALLRESULT", action: "RemoteStartTransaction", payload: { status: "Rejected" } }),
      expect.objectContaining({ messageType: "CALLERROR", action: "Reset", errorCode: "InternalError" }),
    ]));
    const configuration = entries.filter((entry) => entry.action === "GetConfiguration");
    expect(configuration.map((entry) => entry.messageType)).toEqual(["CALL"]);
    const trigger = entries.filter((entry) => entry.action === "TriggerMessage");
    expect(trigger.map((entry) => entry.sequence)).toEqual([trigger[0]?.sequence, (trigger[0]?.sequence ?? 0) + 1]);
    expect(trigger.map((entry) => entry.messageType)).toEqual(["CALL", "CALLRESULT"]);
    collector.stop();
  });

  it("truncates oversized raw frames and records the original byte length", () => {
    const source = fakeSource();
    const collector = new RunTraceCollector(source, { maxEntries: 10, maxRawBytes: 16, maxTranscriptBytes: 10_000 });
    collector.start();
    const raw = "x".repeat(80);
    source.emit({ direction: "inbound", messageType: "UNKNOWN", raw });
    const entry = collector.snapshot().entries[0];
    expect(entry?.originalRawBytes).toBe(Buffer.byteLength(raw, "utf8"));
    expect(Buffer.byteLength(entry?.raw ?? "", "utf8")).toBeLessThanOrEqual(16);
    expect(collector.snapshot().summary.truncatedEntries).toBe(1);
    expect(collector.snapshot().summary.truncated).toBe(true);
  });

  it("drops frames past the entry and transcript budgets without stopping collection", () => {
    const source = fakeSource();
    const collector = new RunTraceCollector(source, { maxEntries: 2, maxRawBytes: 64, maxTranscriptBytes: 10_000 });
    collector.start();
    source.emit(callFrame("one"));
    source.emit(callFrame("two"));
    source.emit(callFrame("three"));
    const byCount = collector.snapshot().summary;
    expect(byCount.capturedEntries).toBe(2);
    expect(byCount.droppedEntries).toBe(1);
    expect(byCount.truncated).toBe(true);

    const probeSource = fakeSource();
    const probe = new RunTraceCollector(probeSource, { maxEntries: 5, maxRawBytes: 1024, maxTranscriptBytes: 100_000 });
    probe.start();
    probeSource.emit({ direction: "inbound", messageType: "UNKNOWN", raw: "ab" });
    const oneEntry = Buffer.byteLength(JSON.stringify(probe.snapshot().entries[0]), "utf8");

    const tight = fakeSource();
    const bounded = new RunTraceCollector(tight, { maxEntries: 20, maxRawBytes: 1024, maxTranscriptBytes: oneEntry + 10 });
    bounded.start();
    tight.emit({ direction: "inbound", messageType: "UNKNOWN", raw: "ab" });
    tight.emit({ direction: "inbound", messageType: "UNKNOWN", raw: "cd" });
    tight.emit({ direction: "outbound", messageType: "UNKNOWN", raw: "ef" });
    const byBytes = bounded.snapshot().summary;
    expect(byBytes.capturedEntries).toBe(1);
    expect(byBytes.droppedEntries).toBe(2);
    expect(byBytes.truncated).toBe(true);
  });

  it("stores a large parsed payload once", () => {
    const source = fakeSource();
    const collector = new RunTraceCollector(source, {
      maxEntries: 5,
      maxRawBytes: 64 * 1024,
      maxTranscriptBytes: 1024 * 1024,
    });
    collector.start();
    const payload = { samples: "m".repeat(2_000), password: "hunter2" };
    source.emit({
      direction: "inbound",
      messageType: "CALL",
      action: "MeterValues",
      uniqueId: "m1",
      payload,
      raw: JSON.stringify([2, "m1", "MeterValues", payload]),
    });
    const entry = collector.snapshot().entries[0];
    expect(entry?.raw).toBeUndefined();
    expect(entry?.payload).toMatchObject({ password: "[REDACTED]" });
    expect(JSON.stringify(entry)).not.toContain("hunter2");
  });
});

describe("trace presentation", () => {
  it("returns an empty transcript for historical runs and keeps entries off the run summary", () => {
    expect(presentTrace("abc123", undefined)).toEqual({
      runId: "abc123",
      summary: { capturedEntries: 0, droppedEntries: 0, truncatedEntries: 0, truncated: false },
      entries: [],
      page: { limit: 0, returned: 0, nextAfterSequence: null, hasMore: false },
    });

    const presented = presentRun({
      _id: { toString: () => "abc123" },
      chargePointIdentity: "CP001",
      caseIds: ["heartbeat"],
      status: "passed",
      summary: { total: 1, passed: 1, failed: 0, error: 0 },
      results: [],
      createdAt: new Date("2026-10-05T12:00:00.000Z"),
      trace: {
        summary: { capturedEntries: 1, droppedEntries: 2, truncatedEntries: 0, truncated: true },
        entries: [{ ...sampleEntry(), payload: { password: "not-in-the-list" } }],
      },
    } as unknown as TestRunRecord);

    expect(presented.trace).toEqual({
      capturedEntries: 1,
      droppedEntries: 2,
      truncatedEntries: 0,
      truncated: true,
    });
    expect(presented.trace).not.toHaveProperty("entries");
    expect(JSON.stringify(presented)).not.toContain("not-in-the-list");
  });

  it("filters stored entries without changing the capture summary", () => {
    const entries: TraceEntry[] = [
      sampleEntry(),
      { ...sampleEntry(), sequence: 2, action: "Heartbeat", caseId: "heartbeat", direction: "csms-to-charge-point", messageType: "CALLRESULT" },
    ];
    const trace = presentTrace(
      "run-1",
      {
        summary: { capturedEntries: 2, droppedEntries: 0, truncatedEntries: 0, truncated: false },
        entries,
      },
      { caseId: "heartbeat", action: "Heartbeat", direction: "csms-to-charge-point", messageType: "CALLRESULT" },
    );
    expect(trace.summary.capturedEntries).toBe(2);
    expect(trace.entries).toHaveLength(1);
    expect(trace.entries[0]?.sequence).toBe(2);
    expect(trace.page).toEqual({ limit: 1, returned: 1, nextAfterSequence: null, hasMore: false });
  });

  it("pages filtered entries in ascending sequence order", () => {
    const entries = [3, 1, 2].map((sequence) => ({ ...sampleEntry(), sequence, caseId: sequence === 2 ? "other" : "heartbeat" }));
    const first = presentTrace("run-1", { summary: { capturedEntries: 3, droppedEntries: 0, truncatedEntries: 0, truncated: false }, entries }, { caseId: "heartbeat" }, undefined, { limit: 1 });
    expect(first.entries.map((entry) => entry.sequence)).toEqual([1]);
    expect(first.page).toEqual({ limit: 1, returned: 1, nextAfterSequence: 1, hasMore: true });
    const second = presentTrace("run-1", { summary: { capturedEntries: 3, droppedEntries: 0, truncatedEntries: 0, truncated: false }, entries }, { caseId: "heartbeat" }, undefined, { limit: 1, afterSequence: 1 });
    expect(second.entries.map((entry) => entry.sequence)).toEqual([3]);
    expect(second.page.hasMore).toBe(false);
    expect(() => readTracePage({ limit: "501" })).toThrow(/limit must be an integer/);
  });

  it("rejects invalid filters", () => {
    expect(() => readTraceFilter({ direction: "sideways" })).toThrow(/direction must be/);
    expect(() => readTraceFilter({ messageType: "PING" })).toThrow(/messageType must be/);
    expect(() => readTraceFilter({ caseId: "" })).toThrow(/caseId must be a non-empty string/);
    expect(readTraceFilter({})).toEqual({});
  });
});

describe("GET /api/runs/:id/trace", () => {
  afterEach(async () => {
    findById.mockReset();
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it("returns 404 for an unknown run and 400 for an invalid filter", async () => {
    const base = await listen();
    findById.mockReturnValue({ lean: async () => null });

    const missing = await fetch(`${base}/api/runs/507f1f77bcf86cd799439011/trace`);
    expect(missing.status).toBe(404);

    const invalidId = await fetch(`${base}/api/runs/not-an-id/trace`);
    expect(invalidId.status).toBe(404);

    const invalid = await fetch(`${base}/api/runs/507f1f77bcf86cd799439011/trace?messageType=PING`);
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: string }).error).toMatch(/messageType must be/);
  });

  it("filters a stored transcript and returns an empty body for a historical run", async () => {
    const base = await listen();
    findById.mockImplementation((id: string) => ({
      lean: async () => {
        if (id.endsWith("2")) {
          return {
            _id: id,
            chargePointIdentity: "CP001",
            caseIds: ["heartbeat"],
            status: "passed",
            createdAt: new Date("2026-10-06T00:00:00.000Z"),
            summary: { total: 1, passed: 1, failed: 0, error: 0 },
            results: [],
          };
        }
        return {
          _id: id,
          createdAt: new Date("2026-10-06T00:00:00.000Z"),
          trace: {
            summary: { capturedEntries: 2, droppedEntries: 1, truncatedEntries: 0, truncated: true },
            entries: [
              sampleEntry(),
              {
                ...sampleEntry(),
                sequence: 2,
                action: "Heartbeat",
                caseId: "heartbeat",
                messageType: "CALL",
              },
            ],
          },
        };
      },
    }));

    const filtered = await fetch(
      `${base}/api/runs/507f1f77bcf86cd799439011/trace?caseId=heartbeat&action=Heartbeat&direction=charge-point-to-csms&messageType=CALL`,
    );
    expect(filtered.status).toBe(200);
    const body = (await filtered.json()) as { summary: { capturedEntries: number; truncated: boolean }; entries: TraceEntry[] };
    expect(body.summary).toMatchObject({ capturedEntries: 2, truncated: true });
    expect(body.entries.map((entry) => entry.sequence)).toEqual([2]);

    const historical = await fetch(`${base}/api/runs/507f1f77bcf86cd799439012/trace`);
    expect(historical.status).toBe(200);
    expect(await historical.json()).toEqual({
      runId: "507f1f77bcf86cd799439012",
      summary: { capturedEntries: 0, droppedEntries: 0, truncatedEntries: 0, truncated: false },
      entries: [],
      profile: { schemaVersion: "1", name: "default-ocpp16" },
      page: { limit: 0, returned: 0, nextAfterSequence: null, hasMore: false },
    });
  });
});

function sampleEntry(): TraceEntry {
  return {
    sequence: 1,
    at: "2026-10-06T12:00:00.000Z",
    direction: "charge-point-to-csms",
    messageType: "CALL",
    action: "BootNotification",
    uniqueId: "u1",
    caseId: "boot-notification",
    payload: {},
  };
}

function callFrame(uniqueId: string): OcppObservedFrame {
  return {
    direction: "inbound",
    messageType: "CALL",
    uniqueId,
    action: "Heartbeat",
    payload: {},
    raw: JSON.stringify([2, uniqueId, "Heartbeat", {}]),
  };
}

function fakeSource(): FrameSource & { emit(frame: OcppObservedFrame): void } {
  let observer: OcppFrameObserver | undefined;
  return {
    observe(next) {
      observer = next;
      return () => {
        if (observer === next) {
          observer = undefined;
        }
      };
    },
    emit(frame) {
      observer?.(frame);
    },
  };
}

async function listen(): Promise<string> {
  const app = createApp(new SessionRegistry());
  const httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  server = httpServer;
  const address = httpServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

let server: Server | undefined;
