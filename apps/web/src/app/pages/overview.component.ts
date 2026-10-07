import { Component, inject, signal } from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import { forkJoin } from "rxjs";
import { ApiService } from "../core/api.service";
import { formatWhen } from "../core/lab-format";
import { LabState } from "../core/lab-state.service";
import type { CatalogDocument, ChargePoint, HealthStatus, SimulatorStatus, TestRun } from "../models";
import { StateBlockComponent } from "../components/state-block.component";
import { StatusPillComponent } from "../components/status-pill.component";

@Component({
  selector: "app-overview",
  imports: [RouterLink, StateBlockComponent, StatusPillComponent],
  template: `
    <header class="page-header">
      <div>
        <p class="eyebrow">Lab</p>
        <h1>Charge point bench</h1>
      </div>
      <button type="button" class="ghost" (click)="load()">Refresh</button>
    </header>
    <app-state-block [loading]="loading()" [error]="error()" [hasContent]="loaded()" (retry)="load()" />
    @if (loaded()) {
      <section class="stats">
        <article><span>API</span><strong>{{ health()?.status }}</strong></article>
        <article><span>Database</span><strong>{{ health()?.database }}</strong></article>
        <article><span>OCPP stations</span><strong>{{ connectedStations() }}</strong></article>
        <article><span>Simulator control</span><strong>{{ connectedSimulators() }}</strong></article>
        <article><span>Active runs</span><strong>{{ activeRuns() }}</strong></article>
        <article><span>Cases</span><strong>{{ catalog()?.cases?.length ?? 0 }}</strong></article>
        <article><span>Scenarios</span><strong>{{ catalog()?.scenarios?.length ?? 0 }}</strong></article>
        <article><span>Suites</span><strong>{{ catalog()?.suites?.length ?? 0 }}</strong></article>
      </section>
      @if (latest(); as run) {
        <section class="panel">
          <p class="eyebrow">Latest run</p>
          <p><app-status-pill [status]="run.status" /> <a [routerLink]="['/runs', run.id]"><code>{{ run.id }}</code></a></p>
          <p class="muted">{{ when(run.createdAt).local }}</p>
          <p class="muted">Trace {{ run.trace?.capturedEntries ?? 0 }} captured{{ run.trace?.truncated ? ", truncated" : "" }}.</p>
        </section>
      }
      <section class="station-grid">
        @for (suite of quickSuites; track suite.id) {
          <article class="panel">
            <h2>{{ suite.title }}</h2>
            <p class="muted">{{ suite.detail }}</p>
            @if (suiteBlocked(suite.id); as reason) {
              <p class="banner warn" role="status">{{ reason }}</p>
            }
            <button type="button" class="primary" (click)="launch(suite.id, suite.title)">Open in catalog</button>
          </article>
        }
      </section>
    }
  `,
})
export class OverviewComponent {
  private readonly api = inject(ApiService);
  private readonly lab = inject(LabState);
  private readonly router = inject(Router);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly loaded = signal(false);
  readonly health = signal<HealthStatus | null>(null);
  readonly stations = signal<ChargePoint[]>([]);
  readonly simulators = signal<SimulatorStatus[]>([]);
  readonly runs = signal<TestRun[]>([]);
  readonly catalog = signal<CatalogDocument | null>(null);
  readonly quickSuites = [
    { id: "smoke", title: "Smoke", detail: "Boot, heartbeat, and status." },
    { id: "full-ocpp16", title: "Physical regression", detail: "Physical-compatible OCPP 1.6 suite." },
    { id: "simulator-negative", title: "Simulator-negative", detail: "Fault injection. Requires simulator control." },
  ];

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    forkJoin({
      health: this.api.health(),
      stations: this.api.chargePoints(),
      simulators: this.api.simulators(),
      runs: this.api.runs(),
      catalog: this.api.catalog(),
    }).subscribe({
      next: (data) => {
        this.health.set(data.health);
        this.stations.set(data.stations);
        this.simulators.set(data.simulators);
        this.runs.set(data.runs);
        this.catalog.set(data.catalog);
        this.loaded.set(true);
        this.loading.set(false);
        this.error.set(null);
      },
      error: () => {
        this.loading.set(false);
        this.error.set(this.loaded() ? "The latest refresh failed." : "The lab API is unavailable.");
      },
    });
  }

  connectedStations(): number {
    return this.stations().filter((station) => station.status === "connected").length;
  }

  connectedSimulators(): number {
    return this.simulators().filter((simulator) => simulator.connected).length;
  }

  activeRuns(): number {
    return this.runs().filter((run) => run.status === "queued" || run.status === "running").length;
  }

  latest(): TestRun | undefined {
    return this.runs().find((run) => run.status === "passed" || run.status === "failed" || run.status === "error");
  }

  suiteBlocked(id: string): string | null {
    if (id !== "simulator-negative") {
      return null;
    }
    const station = this.stations().find((item) => item.status === "connected");
    const simulator = station ? this.simulators().find((item) => item.identity === station.identity && item.connected) : undefined;
    if (!simulator?.capabilities.includes("simulator-control")) {
      return "The connected station does not expose simulator-control, so this suite cannot run there.";
    }
    return null;
  }

  launch(id: string, title: string): void {
    const suite = this.catalog()?.suites.find((item) => item.id === id);
    this.lab.selectOnly({ kind: "suite", id, title: suite?.title ?? title });
    void this.router.navigate(["/catalog"]);
  }

  when(value: string): { local: string; utc: string } {
    return formatWhen(value);
  }
}
