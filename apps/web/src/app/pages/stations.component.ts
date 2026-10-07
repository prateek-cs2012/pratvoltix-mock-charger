import { Component, DestroyRef, inject, signal } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { RouterLink } from "@angular/router";
import { forkJoin, timer } from "rxjs";
import { switchMap } from "rxjs/operators";
import { ApiService } from "../core/api.service";
import { formatWhen } from "../core/lab-format";
import { LabState } from "../core/lab-state.service";
import type { ChargePoint, SimulatorStatus } from "../models";
import { StateBlockComponent } from "../components/state-block.component";
import { StatusPillComponent } from "../components/status-pill.component";

@Component({
  selector: "app-stations",
  imports: [RouterLink, StateBlockComponent, StatusPillComponent],
  template: `
    <header class="page-header">
      <div>
        <p class="eyebrow">Stations</p>
        <h1>Connected charge points</h1>
      </div>
      <button type="button" class="ghost" (click)="load()">Refresh</button>
    </header>
    <p class="muted">Last refresh {{ refreshed() || "not yet" }}</p>
    <app-state-block [loading]="loading()" [error]="error()" [empty]="stations().length === 0 && loaded()" [hasContent]="stations().length > 0" emptyText="No stations have connected yet." (retry)="load()" />
    <section class="station-grid">
      @for (station of stations(); track station.identity) {
        <article class="panel station">
          <header>
            <h2>{{ station.identity }}</h2>
            <app-status-pill [status]="station.status" [label]="station.status === 'connected' ? 'OCPP connected' : 'OCPP disconnected'" />
          </header>
          <p>
            <app-status-pill [status]="simulator(station.identity)?.connected ? 'connected' : 'disconnected'" [label]="simulator(station.identity)?.connected ? 'Simulator connected' : 'Physical/standard station'" />
          </p>
          @if ((simulator(station.identity)?.activeFaults.length ?? 0) > 0) {
            <p class="banner warn" role="status">{{ simulator(station.identity)?.activeFaults.length }} active simulator fault{{ simulator(station.identity)?.activeFaults.length === 1 ? "" : "s" }}.</p>
          }
          <dl>
            <div><dt>OCPP</dt><dd>{{ station.ocppVersion }}</dd></div>
            <div><dt>Vendor</dt><dd>{{ station.vendor || "Unknown" }} {{ station.model || "" }}</dd></div>
            <div><dt>Firmware</dt><dd>{{ station.firmwareVersion || "Unknown" }}</dd></div>
            <div><dt>Connector</dt><dd>{{ station.connectorStatus || "Unknown" }}</dd></div>
            <div><dt>Transaction</dt><dd>{{ station.activeTransactionId ?? "None" }}</dd></div>
            <div><dt>Last seen</dt><dd><time [title]="when(station.lastSeenAt).utc">{{ when(station.lastSeenAt).local }}</time></dd></div>
            <div><dt>Simulator</dt><dd>{{ simulator(station.identity)?.simulatorName || "Not connected" }} {{ simulator(station.identity)?.simulatorVersion || "" }}</dd></div>
            <div><dt>Capabilities</dt><dd>{{ simulator(station.identity)?.capabilities?.join(", ") || "None" }}</dd></div>
            <div><dt>Control connected</dt><dd><time [title]="when(simulator(station.identity)?.connectedAt).utc">{{ when(simulator(station.identity)?.connectedAt).local }}</time></dd></div>
            <div><dt>Control last seen</dt><dd><time [title]="when(simulator(station.identity)?.lastSeenAt).utc">{{ when(simulator(station.identity)?.lastSeenAt).local }}</time></dd></div>
            <div><dt>Last cleanup</dt><dd>{{ cleanup(station.identity) }}</dd></div>
          </dl>
          <a class="primary" routerLink="/catalog" (click)="choose(station.identity)">Run compatible tests</a>
        </article>
      }
    </section>
  `,
})
export class StationsComponent {
  private readonly api = inject(ApiService);
  private readonly lab = inject(LabState);
  readonly stations = signal<ChargePoint[]>([]);
  readonly simulators = signal<SimulatorStatus[]>([]);
  readonly loading = signal(true);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);
  readonly refreshed = signal("");

  constructor() {
    const destroyRef = inject(DestroyRef);
    timer(0, 5000).pipe(switchMap(() => forkJoin({ stations: this.api.chargePoints(), simulators: this.api.simulators() })), takeUntilDestroyed(destroyRef)).subscribe({
      next: (data) => this.apply(data.stations, data.simulators),
      error: () => {
        this.loading.set(false);
        this.error.set(this.loaded() ? "Refresh failed. Showing the last station snapshot." : "The lab API is unavailable.");
      },
    });
  }

  load(): void {
    this.loading.set(true);
    forkJoin({ stations: this.api.chargePoints(), simulators: this.api.simulators() }).subscribe({
      next: (data) => this.apply(data.stations, data.simulators),
      error: () => {
        this.loading.set(false);
        this.error.set(this.loaded() ? "Refresh failed. Showing the last station snapshot." : "The lab API is unavailable.");
      },
    });
  }

  simulator(identity: string): SimulatorStatus | undefined {
    return this.simulators().find((simulator) => simulator.identity === identity);
  }

  cleanup(identity: string): string {
    const cleanup = this.simulator(identity)?.lastCleanup;
    if (!cleanup) {
      return "None";
    }
    return cleanup.ok ? `ok ${formatWhen(cleanup.at).local}` : `failed ${cleanup.error ?? ""}`;
  }

  choose(identity: string): void {
    this.lab.stationId.set(identity);
  }

  when(value: string | null | undefined): { local: string; utc: string } {
    return formatWhen(value);
  }

  private apply(stations: ChargePoint[], simulators: SimulatorStatus[]): void {
    this.stations.set(stations);
    this.simulators.set(simulators);
    this.loaded.set(true);
    this.loading.set(false);
    this.error.set(null);
    this.refreshed.set(formatWhen(new Date().toISOString()).local);
  }
}
