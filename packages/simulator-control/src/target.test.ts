import { describe, expect, it } from "vitest";
import { TargetError, publicTargetSnapshot, resolveCsmsTarget, sanitizeCsmsUrl } from "./target.js";

const base = "ws://localhost:4200/ocpp";

describe("CSMS target resolution", () => {
  it("prefers a per-run target over the environment and the default", () => {
    const resolved = resolveCsmsTarget({
      stationId: "CP001",
      request: { mode: "external", urlTemplate: "wss://csms.example.com/ocpp/{stationId}?token=secret" },
      environmentUrl: "ws://env.example/ocpp/{stationId}",
      defaultBaseUrl: base,
    });
    expect(resolved.configurationSource).toBe("run");
    expect(resolved.mode).toBe("external");
    expect(resolved.rawEndpoint).toBe("wss://csms.example.com/ocpp/CP001?token=secret");
    expect(resolved.resolvedEndpoint).toBe("wss://csms.example.com/ocpp/CP001?token=redacted");
    expect(resolved.urlTemplate).toBe("wss://csms.example.com/ocpp/{stationId}?token=redacted");
    expect("rawEndpoint" in publicTargetSnapshot(resolved)).toBe(false);
  });

  it("uses TARGET_CSMS_URL when the request omits a target", () => {
    const resolved = resolveCsmsTarget({
      stationId: "CP001",
      environmentUrl: "ws://host.docker.internal:9101/independent/{stationId}",
      defaultBaseUrl: base,
    });
    expect(resolved).toMatchObject({
      mode: "external",
      configurationSource: "environment",
      resolvedEndpoint: "ws://host.docker.internal:9101/independent/CP001",
    });
  });

  it("lets an explicit embedded request override the environment URL", () => {
    const resolved = resolveCsmsTarget({
      stationId: "CP001",
      request: { mode: "embedded" },
      environmentUrl: "ws://host.docker.internal:9101/independent/{stationId}",
      defaultBaseUrl: base,
    });
    expect(resolved).toMatchObject({
      mode: "embedded",
      configurationSource: "run",
      resolvedEndpoint: "ws://localhost:4200/ocpp/CP001",
    });
  });

  it("uses the application default when no request or environment URL is set", () => {
    const resolved = resolveCsmsTarget({ stationId: "CP 1", defaultBaseUrl: base });
    expect(resolved.configurationSource).toBe("default");
    expect(resolved.resolvedEndpoint).toBe("ws://localhost:4200/ocpp/CP%201");
  });

  it("appends the station id without rewriting the query string", () => {
    const resolved = resolveCsmsTarget({
      stationId: "CP001",
      request: { mode: "external", urlTemplate: "ws://probe.example/independent?token=secret" },
      defaultBaseUrl: base,
    });
    expect(resolved.rawEndpoint).toBe("ws://probe.example/independent/CP001?token=secret");
    expect(resolved.resolvedEndpoint).toBe("ws://probe.example/independent/CP001?token=redacted");
  });

  it("removes URL user information from the stored form", () => {
    const resolved = resolveCsmsTarget({
      stationId: "CP001",
      request: { mode: "external", urlTemplate: "wss://user:s3cret@csms.example.com/ocpp/{stationId}" },
      defaultBaseUrl: base,
    });
    expect(resolved.rawEndpoint).toContain("user:s3cret");
    expect(resolved.resolvedEndpoint).toBe("wss://csms.example.com/ocpp/CP001");
    expect(resolved.urlTemplate).toBe("wss://csms.example.com/ocpp/{stationId}");
    expect(sanitizeCsmsUrl(resolved.rawEndpoint)).not.toContain("s3cret");
  });

  it("rejects missing, non-websocket, malformed, unknown, and unresolved targets", () => {
    expect(() =>
      resolveCsmsTarget({
        stationId: "CP001",
        request: { mode: "external" },
        environmentUrl: "ws://fallback.example/{stationId}",
        defaultBaseUrl: base,
      }),
    ).toThrow(TargetError);
    expect(() =>
      resolveCsmsTarget({
        stationId: "CP001",
        request: { mode: "external" },
        environmentUrl: "ws://fallback.example/{stationId}",
        defaultBaseUrl: base,
      }),
    ).toThrow(/requires a target URL/);
    for (const urlTemplate of ["http://csms.example/ocpp/{stationId}", "not a url", "ws://csms.example/{chargerId}", "ws://csms.example/{stationId"]) {
      expect(() =>
        resolveCsmsTarget({
          stationId: "CP001",
          request: { mode: "external", urlTemplate },
          defaultBaseUrl: base,
        }),
      ).toThrow(TargetError);
    }
    try {
      resolveCsmsTarget({
        stationId: "CP001",
        request: { mode: "external", urlTemplate: "http://user:secret@csms.example/ocpp/{stationId}" },
        defaultBaseUrl: base,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TargetError);
      expect((error as Error).message).not.toContain("secret");
      expect((error as Error).message).not.toContain("http://");
    }
  });
});
