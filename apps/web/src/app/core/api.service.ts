import { HttpClient, HttpParams } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { Observable } from "rxjs";
import type {
  CatalogDocument,
  ChargePoint,
  HealthStatus,
  LabSettings,
  RunPreview,
  SimulatorStatus,
  TestRun,
  TracePage,
} from "../models";

@Injectable({ providedIn: "root" })
export class ApiService {
  private readonly http = inject(HttpClient);

  health(): Observable<HealthStatus> {
    return this.http.get<HealthStatus>("/health");
  }

  settings(): Observable<LabSettings> {
    return this.http.get<LabSettings>("/api/settings");
  }

  chargePoints(): Observable<ChargePoint[]> {
    return this.http.get<ChargePoint[]>("/api/charge-points");
  }

  simulators(): Observable<SimulatorStatus[]> {
    return this.http.get<SimulatorStatus[]>("/api/simulators");
  }

  catalog(): Observable<CatalogDocument> {
    return this.http.get<CatalogDocument>("/api/catalog");
  }

  runs(): Observable<TestRun[]> {
    return this.http.get<TestRun[]>("/api/runs");
  }

  run(id: string): Observable<TestRun> {
    return this.http.get<TestRun>(`/api/runs/${encodeURIComponent(id)}`);
  }

  createRun(body: Record<string, unknown>): Observable<TestRun> {
    return this.http.post<TestRun>("/api/runs", body);
  }

  preview(body: Record<string, unknown>): Observable<RunPreview> {
    return this.http.post<RunPreview>("/api/run-plans/resolve", body);
  }

  trace(id: string, query: Record<string, string | number | undefined>): Observable<TracePage> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        params = params.set(key, String(value));
      }
    }
    return this.http.get<TracePage>(`/api/runs/${encodeURIComponent(id)}/trace`, { params });
  }
}
