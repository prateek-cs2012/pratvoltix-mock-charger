import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { SessionRegistry } from "./ocpp/registry.js";
import { presentRun } from "./runs.js";
import type { TestRunRecord } from "./models/test-run.js";

describe("run HTTP API", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it("returns 400 for an unknown selection and accepts legacy caseIds before checking the session", async () => {
    const base = await listen();

    const unknown = await post(base, {
      chargePointIdentity: "CP001",
      selection: { suiteIds: ["missing-suite"] },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/Suite "missing-suite" was not found/);

    const legacy = await post(base, {
      chargePointIdentity: "CP001",
      caseIds: ["heartbeat"],
    });
    expect(legacy.status).toBe(409);
    expect(legacy.body.error).toMatch(/CP001 is not connected/);

    const malformed = await post(base, { chargePointIdentity: "CP001", selection: { caseIds: [1] } });
    expect(malformed.status).toBe(400);
  });

  async function listen(): Promise<string> {
    const app = createApp(new SessionRegistry());
    server = createServer(app);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }
});

describe("presentRun", () => {
  it("keeps runs that were stored before plans existed readable", () => {
    const presented = presentRun({
      _id: { toString: () => "abc123" },
      chargePointIdentity: "CP001",
      caseIds: ["heartbeat"],
      status: "passed",
      summary: { total: 1, passed: 1, failed: 0, error: 0 },
      results: [],
      createdAt: new Date("2026-10-05T12:00:00.000Z"),
    } as unknown as TestRunRecord);

    expect(presented.caseIds).toEqual(["heartbeat"]);
    expect(presented.selection).toBeNull();
    expect(presented.plan).toBeNull();
    expect(presented.status).toBe("passed");
    expect(presented.trace).toEqual({
      capturedEntries: 0,
      droppedEntries: 0,
      truncatedEntries: 0,
      truncated: false,
    });
    expect(presented.trace).not.toHaveProperty("entries");
    expect(presented.profile).toMatchObject({
      schemaVersion: "1",
      name: "default-ocpp16",
      stored: false,
      parameters: { idTag: "TEST-TAG-001", connectorId: 1 },
    });
  });
});

async function post(base: string, body: unknown): Promise<{ status: number; body: { error?: string } }> {
  const response = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { error?: string } };
}
