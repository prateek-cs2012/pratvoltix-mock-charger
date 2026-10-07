import { provideHttpClient } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from "@angular/router";
import { of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { AppComponent } from "./app.component";
import { formatJson } from "./components/json-viewer.component";
import { RunLauncherComponent } from "./components/run-launcher.component";
import { TraceViewerComponent } from "./components/trace-viewer.component";
import { copyText, downloadText } from "./core/download";
import { formatWhen, localOverrideError, matchesQuery, safeDownloadName, selectionBody, traceNdjson, typedOverrides } from "./core/lab-format";
import { externalTargetError, sanitizedEndpoint } from "./core/target-form";
import { LabState } from "./core/lab-state.service";
import type { ProfileParameterSpec, TraceEntry } from "./models";
import { CatalogComponent } from "./pages/catalog.component";
import { RunDetailComponent } from "./pages/run-detail.component";

const integerSpec: ProfileParameterSpec = {
  name: "connectorId",
  type: "integer",
  description: "Connector",
  persisted: true,
  default: 1,
  minimum: 0,
  maximum: 1000,
};

const catalogBody = {
  version: "test",
  cases: [
    { id: "heartbeat", title: "Heartbeat", description: "Pulse", version: "1.6", tags: ["core"], requirements: [], timeoutMs: 5000 },
    { id: "fault", title: "Fault", description: "Negative", version: "1.6", tags: ["sim"], requirements: ["simulator-control"], timeoutMs: 8000 },
  ],
  scenarios: [
    { id: "smoke", title: "Smoke", description: "Short", version: "1.6", tags: ["core"], requirements: [], caseIds: ["heartbeat"] },
  ],
  suites: [
    { id: "simulator-negative", title: "Negative", description: "Faults", version: "1.6", tags: ["sim"], requirements: ["simulator-control"], caseIds: ["fault"], scenarioIds: ["negative"] },
  ],
  profile: { schemaVersions: ["1"], nonSecret: true, notice: "not secrets", parameters: [integerSpec] },
};

describe("operator console helpers", () => {
  it("formats dates without an ambiguous numeric month", () => {
    const formatted = formatWhen("2026-10-06T07:50:50.000Z");
    expect(formatted.local).toContain("2026");
    expect(formatted.local).toContain("Oct");
    expect(formatted.local).not.toMatch(/\d{1,2}\/\d{1,2}\/2026/);
    expect(formatted.utc).toBe("2026-10-06T07:50:50.000Z");
  });

  it("keeps mixed selections labeled by type", () => {
    expect(selectionBody([
      { kind: "case", id: "heartbeat", title: "Heartbeat" },
      { kind: "suite", id: "smoke", title: "Smoke" },
    ])).toEqual({ caseIds: ["heartbeat"], scenarioIds: [], suiteIds: ["smoke"] });
  });

  it("types overrides from catalog specs and resets them", () => {
    const lab = new LabState();
    lab.setOverride("connectorId", "2");
    lab.setOverride("idTag", "LAB");
    expect(typedOverrides(lab.overrides(), [integerSpec, { ...integerSpec, name: "idTag", type: "string", default: "TEST" }])).toEqual({
      connectorId: 2,
      idTag: "LAB",
    });
    expect(localOverrideError(integerSpec, "1001")).toMatch(/connectorId/);
    lab.clearOverride("connectorId");
    expect(lab.overrides()["connectorId"]).toBeUndefined();
    lab.importProfile({ schemaVersion: "1", name: "imported" }, "imported");
    expect(lab.importedName()).toBe("imported");
    lab.resetProfile();
    expect(lab.importedProfile()).toBeNull();
  });

  it("parses an imported profile object and rejects a path-like string", () => {
    const parsed = JSON.parse("{\"name\":\"default-ocpp16\",\"parameters\":{\"idTag\":\"LAB-CARD-002\"}}") as Record<string, unknown>;
    expect(parsed["name"]).toBe("default-ocpp16");
    expect(() => JSON.parse("/tmp/profile.json")).toThrow();
  });

  it("searches catalog text and renders JSON without HTML", () => {
    expect(matchesQuery(["heartbeat", "Pulse"], "pul")).toBe(true);
    expect(formatJson({ note: "café <tag>", nested: { deep: { more: [1] } } }, 0)).toContain("café");
    expect(formatJson({ note: "café <tag>" }, 0)).not.toContain("<div");
    expect(formatJson(null, 0)).toBe("null");
  });

  it("builds complete NDJSON and a safe filename", () => {
    expect(traceNdjson([{ sequence: 1 }, { sequence: 2 }])).toBe("{\"sequence\":1}\n{\"sequence\":2}\n");
    expect(traceNdjson([])).toBe("");
    expect(safeDownloadName("../evil", "ndjson")).toBe("run.ndjson");
    expect(safeDownloadName("abc123", "json")).toBe("abc123.json");
  });
});

const connectedPreview = {
  station: { identity: "CP001", connected: true, ocppVersion: "1.6", capabilities: [] as string[] },
  plan: { catalogVersion: "test", cases: [{ id: "heartbeat", title: "Heartbeat", description: "", version: "1.6", tags: [] as string[], requirements: [] as string[], timeoutMs: 1, origins: [] }] },
  effectiveProfile: { name: "default-ocpp16", schemaVersion: "1", overridden: [] as string[], parameters: {} },
  compatibility: { compatible: true, missingCapabilities: [] as Array<{ capability: string; caseIds: string[] }> },
  estimatedTimeoutMs: 1,
  selection: { caseIds: ["heartbeat"], scenarioIds: [] as string[], suiteIds: [] as string[] },
};

const disconnectedPreview = {
  ...connectedPreview,
  station: { identity: "CP001", connected: false, ocppVersion: "1.6", capabilities: [] as string[] },
  plan: { catalogVersion: "test", cases: [] },
  compatibility: { compatible: false, missingCapabilities: [{ capability: "simulator-control", caseIds: ["fault"] }] },
  estimatedTimeoutMs: 0,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("catalog page", () => {
  it("filters tabs, search, and compatibility without dropping the other selection", async () => {
    await TestBed.configureTestingModule({
      imports: [CatalogComponent],
      providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(CatalogComponent);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.expectOne("/api/catalog").flush(catalogBody);
    http.expectOne("/api/simulators").flush([{ identity: "CP001", connected: true, capabilities: ["simulator-control"], activeFaults: [] }]);
    await fixture.whenStable();
    const component = fixture.componentInstance;
    expect(component.visible().map((item) => item.id)).toEqual(["heartbeat", "fault"]);
    component.query.set("fault");
    expect(component.visible().map((item) => item.id)).toEqual(["fault"]);
    component.query.set("");
    component.compatibility.set("physical");
    expect(component.visible().map((item) => item.id)).toEqual(["heartbeat"]);
    component.lab.stationId.set("CP001");
    component.compatibility.set("station");
    expect(component.visible().map((item) => item.id)).toEqual(["heartbeat", "fault"]);
    component.lab.toggle({ kind: "case", id: "heartbeat", title: "Heartbeat" });
    component.active.set("suites");
    expect(component.lab.isSelected("case", "heartbeat")).toBe(true);
    expect(component.visible().map((item) => item.id)).toEqual(["simulator-negative"]);
    fixture.destroy();
  });

  it("shows an API unavailable message", async () => {
    await TestBed.configureTestingModule({
      imports: [CatalogComponent],
      providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(CatalogComponent);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.expectOne("/api/catalog").flush("down", { status: 503, statusText: "down" });
    expect(http.expectOne("/api/simulators").cancelled).toBe(true);
    await fixture.whenStable();
    expect(fixture.componentInstance.error()).toContain("unavailable");
    fixture.destroy();
  });
});

describe("run launcher", () => {
  it("debounces preview requests and cancels a stale response", async () => {
    await TestBed.configureTestingModule({
      imports: [RunLauncherComponent],
      providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting(), provideRouter([{ path: "runs/:id", children: [] }])],
    }).compileComponents();
    const fixture = TestBed.createComponent(RunLauncherComponent);
    const http = TestBed.inject(HttpTestingController);
    const lab = TestBed.inject(LabState);
    fixture.detectChanges();
    http.expectOne("/api/charge-points").flush([{ identity: "CP001", status: "connected", ocppVersion: "1.6" }]);
    http.expectOne("/api/simulators").flush([]);
    http.expectOne("/api/catalog").flush(catalogBody);
    lab.selectOnly({ kind: "suite", id: "smoke", title: "Smoke" });
    await delay(300);
    const first = http.expectOne("/api/run-plans/resolve");
    lab.selectOnly({ kind: "case", id: "heartbeat", title: "Heartbeat" });
    await delay(300);
    const second = http.expectOne("/api/run-plans/resolve");
    expect(first.cancelled).toBe(true);
    second.flush(disconnectedPreview);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("Missing simulator-control");
    expect(fixture.componentInstance.canRun()).toBe(false);
    fixture.destroy();
  });

  it("submits a run once and navigates to the new run", async () => {
    await TestBed.configureTestingModule({
      imports: [RunLauncherComponent],
      providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting(), provideRouter([{ path: "runs/:id", children: [] }])],
    }).compileComponents();
    const fixture = TestBed.createComponent(RunLauncherComponent);
    const http = TestBed.inject(HttpTestingController);
    const lab = TestBed.inject(LabState);
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, "navigate").mockResolvedValue(true);
    fixture.detectChanges();
    http.expectOne("/api/charge-points").flush([{ identity: "CP001", status: "connected", ocppVersion: "1.6" }]);
    http.expectOne("/api/simulators").flush([]);
    http.expectOne("/api/catalog").flush(catalogBody);
    lab.stationId.set("CP001");
    lab.selectOnly({ kind: "case", id: "heartbeat", title: "Heartbeat" });
    await delay(300);
    http.expectOne("/api/run-plans/resolve").flush(connectedPreview);
    fixture.detectChanges();
    fixture.componentInstance.run();
    fixture.componentInstance.run();
    const created = http.expectOne("/api/runs");
    expect(http.match("/api/runs")).toHaveLength(0);
    expect(created.request.body).toEqual({
      chargePointIdentity: "CP001",
      selection: { caseIds: ["heartbeat"], scenarioIds: [], suiteIds: [] },
      target: { mode: "embedded" },
    });
    created.flush({ id: "run-1", status: "queued" });
    await delay(0);
    expect(navigate).toHaveBeenCalledWith(["/runs", "run-1"]);
    fixture.destroy();
  });

  it("validates an external target and sends the same request shape as the CLI", async () => {
    expect(externalTargetError("http://csms.example/ocpp/{stationId}")).toMatch(/ws: or wss:/);
    expect(externalTargetError("ws://csms.example/{chargerId}")).toMatch(/Unknown target placeholder/);
    expect(sanitizedEndpoint("wss://user:secret@csms.example/ocpp/{stationId}?token=secret", "CP001")).toBe(
      "wss://csms.example/ocpp/CP001?token=redacted",
    );
    expect(sanitizedEndpoint("wss://user:secret@csms.example/ocpp/{stationId}?token=secret", "CP001")).not.toContain("secret");

    await TestBed.configureTestingModule({
      imports: [RunLauncherComponent],
      providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(RunLauncherComponent);
    const http = TestBed.inject(HttpTestingController);
    const lab = TestBed.inject(LabState);
    fixture.detectChanges();
    http.expectOne("/api/charge-points").flush([{ identity: "CP001", status: "connected", ocppVersion: "1.6" }]);
    http.expectOne("/api/simulators").flush([{ identity: "CP001", connected: true, capabilities: ["simulator-control"], activeFaults: [] }]);
    http.expectOne("/api/catalog").flush(catalogBody);
    lab.stationId.set("CP001");
    lab.targetMode.set("external");
    lab.targetUrl.set("http://csms.example/{stationId}");
    lab.selectOnly({ kind: "suite", id: "smoke", title: "Smoke" });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("System under test");
    expect(fixture.nativeElement.textContent).toContain("ws: or wss:");
    expect(fixture.nativeElement.textContent).not.toContain("localhost:4200");
    expect(fixture.componentInstance.canRun()).toBe(false);
    lab.targetUrl.set("ws://host.docker.internal:9101/independent/{stationId}?token=secret");
    await delay(300);
    const preview = http.expectOne("/api/run-plans/resolve");
    expect(preview.request.body).toEqual({
      chargePointIdentity: "CP001",
      selection: { caseIds: [], scenarioIds: [], suiteIds: ["smoke"] },
      target: { mode: "external", urlTemplate: "ws://host.docker.internal:9101/independent/{stationId}?token=secret" },
    });
    preview.flush({
      ...connectedPreview,
      station: { ...connectedPreview.station, simulatorConnected: true },
      target: {
        mode: "external",
        configurationSource: "run",
        urlTemplate: "ws://host.docker.internal:9101/independent/{stationId}?token=redacted",
        resolvedEndpoint: "ws://host.docker.internal:9101/independent/CP001?token=redacted",
        stationIdentity: "CP001",
        requestedSubprotocol: "ocpp1.6",
        negotiatedSubprotocol: null,
      },
    });
    fixture.detectChanges();
    const summary = fixture.nativeElement.querySelector(".sut")?.textContent ?? "";
    expect(summary).toContain("ws://host.docker.internal:9101/independent/CP001?token=redacted");
    expect(summary).not.toContain("token=secret");
    fixture.destroy();
  });
});

describe("run detail and trace", () => {
  it("expands failed cases and keeps historical runs readable", async () => {
    await TestBed.configureTestingModule({
      imports: [RunDetailComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: "old" })), snapshot: { paramMap: convertToParamMap({ id: "old" }) } } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(RunDetailComponent);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    await delay(20);
    const request = http.expectOne("/api/runs/old");
    request.flush({
      id: "old",
      chargePointIdentity: "CP001",
      caseIds: ["heartbeat"],
      status: "failed",
      startedAt: "2026-10-06T07:50:50.000Z",
      finishedAt: "2026-10-06T07:50:51.000Z",
      createdAt: "2026-10-06T07:50:50.000Z",
      summary: { total: 1, passed: 0, failed: 1, error: 0 },
      results: [{ id: "heartbeat", title: "Heartbeat", status: "failed", durationMs: 10, error: "timeout", logs: [] }],
    });
    fixture.detectChanges();
    expect(fixture.componentInstance.expanded("heartbeat", "failed")).toBe(true);
    expect(fixture.nativeElement.textContent).toContain("no stored plan");
    expect(fixture.nativeElement.textContent).toContain("no stored profile");
    fixture.destroy();
  });

  it("filters loaded frames locally and appends the next page", async () => {
    await TestBed.configureTestingModule({
      imports: [TraceViewerComponent],
      providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const fixture = TestBed.createComponent(TraceViewerComponent);
    fixture.componentRef.setInput("runId", "run-1");
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const entry = (sequence: number, uniqueId: string): TraceEntry => ({
      sequence,
      at: "2026-10-06T07:50:50.000Z",
      direction: sequence === 1 ? "csms-to-charge-point" : "charge-point-to-csms",
      messageType: "CALL",
      uniqueId,
      action: "Heartbeat",
      payload: { uniqueId },
      caseId: "heartbeat",
    });
    component.entries.set([entry(1, "abc")]);
    component.uniqueId.set("abc");
    expect(component.visible()).toHaveLength(1);
    component.payloadQuery.set("missing");
    expect(component.visible()).toHaveLength(0);
    component.clearFilters();
    const http = TestBed.inject(HttpTestingController);
    component.load(false);
    http.expectOne((request) => request.url.includes("/api/runs/run-1/trace") && request.params.get("limit") === "100").flush({
      runId: "run-1",
      summary: { capturedEntries: 2, droppedEntries: 0, truncatedEntries: 0, truncated: false },
      entries: [entry(2, "def")],
      page: { limit: 100, returned: 1, nextAfterSequence: null, hasMore: false },
    });
    expect(component.entries().map((item) => item.sequence)).toEqual([1, 2]);
    fixture.destroy();
  });
});

describe("copy, download, and navigation", () => {
  it("copies without replacing the focused element", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    await copyText("pnpm lab -- artifacts export run-1 --output artifacts/ocpp");
    expect(writeText).toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it("downloads text and revokes the object URL", () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:trace");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    downloadText("run-1.ndjson", "{\"sequence\":1}\n", "application/x-ndjson");
    expect(create).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:trace");
  });

  it("uses a wrapping menu control on the shell", async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(".menu-toggle")).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain("Catalog");
    expect(fixture.nativeElement.textContent).not.toContain("Cases");
    fixture.destroy();
  });
});
