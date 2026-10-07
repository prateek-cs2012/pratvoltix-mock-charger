import { Component, computed, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { ApiService } from "../core/api.service";
import { formatDuration, formatWhen, matchesQuery } from "../core/lab-format";
import type { TestRun } from "../models";
import { StateBlockComponent } from "../components/state-block.component";
import { StatusPillComponent } from "../components/status-pill.component";

@Component({
  selector: "app-runs",
  imports: [RouterLink, StateBlockComponent, StatusPillComponent],
  template: `
    <header class="page-header">
      <div>
        <p class="eyebrow">Runs</p>
        <h1>Recent executions</h1>
      </div>
      <button type="button" class="ghost" (click)="load()">Refresh</button>
    </header>
    <app-state-block [loading]="loading()" [error]="error()" [empty]="visible().length === 0 && loaded()" [hasContent]="runs().length > 0" emptyText="No runs stored yet." (retry)="load()" />
    <div class="filters">
      <label>Search <input [value]="query()" (input)="query.set(text($event))" /></label>
      <label>Status
        <select [value]="status()" (change)="status.set(text($event))">
          <option value="">All</option>
          <option>queued</option>
          <option>running</option>
          <option>passed</option>
          <option>failed</option>
          <option>error</option>
        </select>
      </label>
      <label>Station <input [value]="station()" (input)="station.set(text($event))" /></label>
      <label>Profile <input [value]="profile()" (input)="profile.set(text($event))" /></label>
      <label>Selection
        <select [value]="selectionType()" (change)="selectionType.set(text($event))">
          <option value="">All</option>
          <option value="suite">Suites</option>
          <option value="scenario">Scenarios</option>
          <option value="case">Cases</option>
        </select>
      </label>
    </div>
    <div class="run-table">
      @for (run of visible(); track run.id) {
        <a class="run-row" [routerLink]="['/runs', run.id]">
          <span><code>{{ run.id }}</code><br /><time [title]="when(run.createdAt).utc">{{ when(run.createdAt).local }}</time></span>
          <span>{{ run.chargePointIdentity }}</span>
          <app-status-pill [status]="run.status" />
          <span>{{ run.summary.passed }}/{{ run.summary.failed }}/{{ run.summary.error }}</span>
          <span>{{ duration(run) }}</span>
          <span>{{ run.profile?.name || "default" }} · {{ requested(run) }}</span>
          <span>{{ run.trace?.capturedEntries ?? 0 }} frames{{ run.trace?.truncated ? " truncated" : "" }}</span>
        </a>
      }
    </div>
  `,
})
export class RunsComponent {
  private readonly api = inject(ApiService);
  readonly runs = signal<TestRun[]>([]);
  readonly loading = signal(true);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);
  readonly query = signal("");
  readonly status = signal("");
  readonly station = signal("");
  readonly profile = signal("");
  readonly selectionType = signal("");
  readonly visible = computed(() => this.runs().filter((run) => {
    if (this.status() && run.status !== this.status()) {
      return false;
    }
    if (this.station() && !run.chargePointIdentity.toLowerCase().includes(this.station().toLowerCase())) {
      return false;
    }
    if (this.profile() && !(run.profile?.name ?? "").toLowerCase().includes(this.profile().toLowerCase())) {
      return false;
    }
    if (this.selectionType() === "suite" && (run.selection?.suiteIds.length ?? 0) === 0) {
      return false;
    }
    if (this.selectionType() === "scenario" && (run.selection?.scenarioIds.length ?? 0) === 0) {
      return false;
    }
    if (this.selectionType() === "case" && (run.selection?.caseIds.length ?? run.caseIds.length) === 0) {
      return false;
    }
    const titles = run.results.map((result) => result.title).join(" ");
    return matchesQuery([run.id, titles, requestedLabel(run)], this.query());
  }));

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.runs().subscribe({
      next: (runs) => {
        this.runs.set(runs);
        this.loaded.set(true);
        this.loading.set(false);
        this.error.set(null);
      },
      error: () => {
        this.loading.set(false);
        this.error.set(this.loaded() ? "Refresh failed. Showing the last run list." : "The lab API is unavailable.");
      },
    });
  }

  when(value: string): { local: string; utc: string } {
    return formatWhen(value);
  }

  duration(run: TestRun): string {
    return formatDuration(run.startedAt, run.finishedAt);
  }

  text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  requested(run: TestRun): string {
    return requestedLabel(run);
  }
}

function requestedLabel(run: TestRun): string {
  const suites = run.selection?.suiteIds ?? [];
  const scenarios = run.selection?.scenarioIds ?? [];
  const cases = run.selection?.caseIds ?? [];
  return [...suites, ...scenarios, ...cases].join(", ") || run.caseIds.join(", ");
}
