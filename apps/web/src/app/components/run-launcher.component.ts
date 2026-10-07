import { Component, DestroyRef, effect, inject, signal } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { Router } from "@angular/router";
import { catchError, debounceTime, of, Subject, switchMap, tap } from "rxjs";
import { ApiService } from "../core/api.service";
import { localOverrideError, selectionBody, typedOverrides } from "../core/lab-format";
import { externalTargetError, sanitizedEndpoint } from "../core/target-form";
import { LabState } from "../core/lab-state.service";
import type { ChargePoint, ProfileCatalog, RunPreview, SimulatorStatus } from "../models";
import { PlanPreviewComponent } from "./plan-preview.component";
import { ProfileEditorComponent } from "./profile-editor.component";
import { StatusPillComponent } from "./status-pill.component";

@Component({
  selector: "app-run-launcher",
  imports: [PlanPreviewComponent, ProfileEditorComponent, StatusPillComponent],
  template: `
    <section class="panel launch">
      <header class="page-header">
        <div>
          <p class="eyebrow">Launch</p>
          <h2>Run {{ preview()?.plan.cases.length ?? lab.selection().length }} cases</h2>
        </div>
      </header>
      <label>
        Station
        <select [value]="lab.stationId()" (change)="chooseStation($event)">
          @for (station of stations(); track station.identity) {
            <option [value]="station.identity" [selected]="station.identity === lab.stationId()">{{ station.identity }} · {{ station.status }}</option>
          }
        </select>
      </label>
      @if (selectedStation(); as station) {
        <p>
          <app-status-pill [status]="station.status" [label]="station.status === 'connected' ? 'OCPP connected' : 'OCPP disconnected'" />
          <app-status-pill [status]="simulator()?.connected ? 'connected' : 'disconnected'" [label]="simulator()?.connected ? 'Simulator connected' : 'Physical/standard station'" />
        </p>
        <p class="muted">OCPP {{ station.ocppVersion }}. Capabilities {{ simulator()?.capabilities?.join(", ") || "none" }}.</p>
      }
      <label>
        Target mode
        <select [value]="lab.targetMode()" (change)="chooseTargetMode($event)">
          <option value="embedded">Embedded lab CSMS</option>
          <option value="external">External CSMS</option>
        </select>
      </label>
      @if (lab.targetMode() === "external") {
        <label>
          Target URL
          <input [value]="lab.targetUrl()" (input)="chooseTargetUrl($event)" placeholder="ws://host.docker.internal:8080/ocpp/{stationId}" />
        </label>
        @if (targetError(); as problem) {
          <p class="error">{{ problem }}</p>
        }
      }
      <section class="sut" aria-label="System under test">
        <p class="eyebrow">System under test</p>
        <p><strong>{{ lab.targetMode() === "external" ? "External CSMS" : "Embedded lab CSMS" }}</strong></p>
        <p>Station <code>{{ lab.stationId() || "none" }}</code></p>
        <p>Endpoint <code>{{ displayedEndpoint() }}</code></p>
        <p>Requested subprotocol <code>ocpp1.6</code></p>
      </section>
      <ul class="selection-list">
        @for (item of lab.selection(); track item.kind + item.id) {
          <li>
            <span class="tags"><span>{{ item.kind }}</span></span>
            {{ item.title }} <code>{{ item.id }}</code>
            <button type="button" class="ghost" (click)="lab.remove(item.kind, item.id)">Remove</button>
          </li>
        } @empty {
          <li class="muted">Select cases, scenarios, or suites from the catalog.</li>
        }
      </ul>
      @if (profile(); as specs) {
        <app-profile-editor [catalog]="specs" />
      }
      <app-plan-preview [preview]="preview()" />
      @if (error()) {
        <p class="banner bad" role="alert">{{ error() }}</p>
      }
      <button type="button" class="primary" [disabled]="!canRun()" (click)="run()">
        {{ submitting() ? "Starting…" : "Run " + (preview()?.plan.cases.length ?? 0) + " cases" }}
      </button>
    </section>
  `,
})
export class RunLauncherComponent {
  readonly lab = inject(LabState);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly refresh = new Subject<void>();
  readonly stations = signal<ChargePoint[]>([]);
  readonly simulators = signal<SimulatorStatus[]>([]);
  readonly profile = signal<ProfileCatalog | null>(null);
  readonly preview = signal<RunPreview | null>(null);
  readonly error = signal<string | null>(null);
  readonly submitting = signal(false);

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.api.chargePoints().pipe(takeUntilDestroyed()).subscribe({
      next: (stations) => {
        this.stations.set(stations);
        if (!this.lab.stationId() && stations[0]) {
          this.lab.stationId.set(stations[0].identity);
        }
        this.refresh.next();
      },
      error: (error: unknown) => this.error.set(message(error)),
    });
    this.api.simulators().pipe(takeUntilDestroyed()).subscribe({
      next: (simulators) => this.simulators.set(simulators),
      error: () => this.simulators.set([]),
    });
    this.api.catalog().pipe(takeUntilDestroyed()).subscribe({
      next: (catalog) => this.profile.set(catalog.profile),
      error: (error: unknown) => this.error.set(message(error)),
    });
    effect(() => {
      this.lab.stationId();
      this.lab.selection();
      this.lab.overrides();
      this.lab.importedProfile();
      this.lab.targetMode();
      this.lab.targetUrl();
      this.refresh.next();
    });
    this.refresh.pipe(
      debounceTime(250),
      tap(() => this.error.set(null)),
      switchMap(() => {
        const body = this.requestBody();
        if (!body) {
          this.preview.set(null);
          return of(null);
        }
        return this.api.preview(body).pipe(catchError((error: unknown) => {
          this.error.set(message(error));
          this.preview.set(null);
          return of(null);
        }));
      }),
      takeUntilDestroyed(destroyRef),
    ).subscribe((preview) => {
      this.preview.set(preview);
    });
  }

  touch(): void {
    this.refresh.next();
  }

  selectedStation(): ChargePoint | undefined {
    return this.stations().find((station) => station.identity === this.lab.stationId());
  }

  simulator(): SimulatorStatus | undefined {
    return this.simulators().find((simulator) => simulator.identity === this.lab.stationId());
  }

  chooseStation(event: Event): void {
    this.lab.stationId.set((event.target as HTMLSelectElement).value);
    this.refresh.next();
  }

  targetError(): string | null {
    return this.lab.targetMode() === "external" ? externalTargetError(this.lab.targetUrl()) : null;
  }

  displayedEndpoint(): string {
    const previewEndpoint = this.preview()?.target?.resolvedEndpoint;
    if (this.lab.targetMode() === "embedded") {
      return previewEndpoint ?? "Resolving the embedded lab endpoint…";
    }
    if (this.targetError()) {
      return "Enter a valid ws: or wss: target.";
    }
    return previewEndpoint ?? sanitizedEndpoint(this.lab.targetUrl(), this.lab.stationId() || "CP001") ?? "Resolving the external endpoint…";
  }

  chooseTargetMode(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.lab.targetMode.set(value === "external" ? "external" : "embedded");
    this.refresh.next();
  }

  chooseTargetUrl(event: Event): void {
    this.lab.targetUrl.set((event.target as HTMLInputElement).value);
    this.refresh.next();
  }

  canRun(): boolean {
    const preview = this.preview();
    const ready = this.lab.targetMode() === "external"
      ? Boolean(preview?.station.simulatorConnected || this.simulator()?.connected)
      : Boolean(preview?.station.connected);
    return Boolean(preview && ready && preview.compatibility.compatible && preview.plan.cases.length > 0 && !this.submitting() && !this.overrideErrors() && !this.targetError());
  }

  run(): void {
    const body = this.requestBody();
    if (!body || !this.canRun()) {
      return;
    }
    this.submitting.set(true);
    this.api.createRun(body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (created) => {
        this.submitting.set(false);
        void this.router.navigate(["/runs", created.id]);
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        this.error.set(message(error));
      },
    });
  }

  private requestBody(): Record<string, unknown> | null {
    if (!this.lab.stationId() || this.lab.selection().length === 0 || this.targetError()) {
      return null;
    }
    const specs = this.profile()?.parameters ?? [];
    const overrides = typedOverrides(this.lab.overrides(), specs);
    const target = this.lab.targetMode() === "external"
      ? { mode: "external" as const, urlTemplate: this.lab.targetUrl().trim() }
      : { mode: "embedded" as const };
    return {
      chargePointIdentity: this.lab.stationId(),
      selection: selectionBody(this.lab.selection()),
      target,
      ...(this.lab.importedProfile() ? { profile: this.lab.importedProfile() } : {}),
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    };
  }

  private overrideErrors(): boolean {
    const specs = this.profile()?.parameters ?? [];
    return specs.some((spec) => localOverrideError(spec, this.lab.overrides()[spec.name] ?? ""));
  }
}

function message(error: unknown): string {
  if (typeof error === "object" && error && "error" in error) {
    const nested = (error as { error?: { error?: string } }).error?.error;
    if (nested) {
      return nested;
    }
  }
  return "The lab API could not complete that request.";
}
