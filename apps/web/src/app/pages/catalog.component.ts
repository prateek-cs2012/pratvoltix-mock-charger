import { Component, computed, inject, signal } from "@angular/core";
import { forkJoin } from "rxjs";
import { ApiService } from "../core/api.service";
import { matchesQuery } from "../core/lab-format";
import { LabState } from "../core/lab-state.service";
import type { CatalogCase, CatalogDocument, CatalogScenario, CatalogSuite, SelectionKind, SimulatorStatus } from "../models";
import { RunLauncherComponent } from "../components/run-launcher.component";
import { StateBlockComponent } from "../components/state-block.component";

type Tab = "cases" | "scenarios" | "suites";

@Component({
  selector: "app-catalog",
  imports: [RunLauncherComponent, StateBlockComponent],
  template: `
    <header class="page-header">
      <div>
        <p class="eyebrow">Catalog</p>
        <h1>Cases, scenarios, and suites</h1>
      </div>
    </header>
    <app-state-block [loading]="loading()" [error]="error()" [hasContent]="catalog() !== null" (retry)="load()" />
    @if (catalog(); as document) {
      <div class="tabs" role="tablist">
        @for (tab of tabs; track tab.id) {
          <button type="button" role="tab" [attr.aria-selected]="active() === tab.id" [class.active]="active() === tab.id" (click)="active.set(tab.id)">{{ tab.label }}</button>
        }
      </div>
      <div class="filters">
        <label>Search <input [value]="query()" (input)="query.set(text($event))" /></label>
        <label>Tag <input [value]="tag()" (input)="tag.set(text($event))" /></label>
        <label>Version
          <select [value]="version()" (change)="version.set(text($event))">
            <option value="">All</option>
            <option value="1.6">1.6</option>
            <option value="2.0.1">2.0.1</option>
          </select>
        </label>
        <label>Compatibility
          <select [value]="compatibility()" (change)="compatibility.set(text($event))">
            <option value="all">All</option>
          <option value="station">Compatible with selected station</option>
          <option value="physical">Physical-compatible</option>
          <option value="simulator">Simulator-only</option>
          </select>
        </label>
        <button type="button" class="ghost" [disabled]="active() !== 'cases'" (click)="selectVisible()">Select visible cases</button>
        <button type="button" class="ghost" (click)="lab.clearSelection()">Clear selection</button>
      </div>
      <p class="muted">{{ lab.selection().length }} selected · {{ visible().length }} shown</p>
      <div class="case-list" role="tabpanel">
        @for (item of visible(); track item.id) {
          <label class="case">
            <input type="checkbox" [checked]="lab.isSelected(kind(), item.id)" (change)="lab.toggle({ kind: kind(), id: item.id, title: item.title })" />
            <span>
              <span class="case-title">{{ item.title }} <code>{{ item.id }}</code></span>
              <span class="muted">{{ item.description }}</span>
              <span class="tags">
                <span>{{ item.version }}</span>
                @for (tag of item.tags; track tag) { <span>{{ tag }}</span> }
                <span>{{ requirementLabel(item) }}</span>
                @if (caseCount(item) !== null) { <span>{{ caseCount(item) }} cases</span> }
                @if (timeout(item) !== null) { <span>{{ timeout(item) }} ms</span> }
              </span>
              @if (order(item); as sequence) {
                <span class="muted">Order {{ sequence }}</span>
              }
            </span>
          </label>
        }
      </div>
      <app-run-launcher />
    }
  `,
})
export class CatalogComponent {
  private readonly api = inject(ApiService);
  readonly lab = inject(LabState);
  readonly catalog = signal<CatalogDocument | null>(null);
  readonly simulators = signal<SimulatorStatus[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly active = signal<Tab>("cases");
  readonly query = signal("");
  readonly tag = signal("");
  readonly version = signal("");
  readonly compatibility = signal("all");
  readonly tabs = [
    { id: "cases" as const, label: "Cases" },
    { id: "scenarios" as const, label: "Scenarios" },
    { id: "suites" as const, label: "Suites" },
  ];
  readonly visible = computed(() => this.filter(this.entries()));

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    forkJoin({ catalog: this.api.catalog(), simulators: this.api.simulators() }).subscribe({
      next: (data) => {
        this.catalog.set(data.catalog);
        this.simulators.set(data.simulators);
        this.loading.set(false);
        this.error.set(null);
      },
      error: () => {
        this.loading.set(false);
        this.error.set(this.catalog() ? "Refresh failed. Showing the last catalog." : "The lab API is unavailable.");
      },
    });
  }

  kind(): SelectionKind {
    return this.active() === "cases" ? "case" : this.active() === "scenarios" ? "scenario" : "suite";
  }

  entries(): Array<CatalogCase | CatalogScenario | CatalogSuite> {
    const document = this.catalog();
    if (!document) {
      return [];
    }
    if (this.active() === "cases") {
      return document.cases;
    }
    if (this.active() === "scenarios") {
      return document.scenarios;
    }
    return document.suites;
  }

  filter(entries: Array<CatalogCase | CatalogScenario | CatalogSuite>): Array<CatalogCase | CatalogScenario | CatalogSuite> {
    return entries.filter((item) => {
      if (!matchesQuery([item.id, item.title, item.description, item.tags.join(" ")], this.query())) {
        return false;
      }
      if (this.tag() && !item.tags.some((tag) => tag.toLowerCase().includes(this.tag().toLowerCase()))) {
        return false;
      }
      if (this.version() && item.version !== this.version()) {
        return false;
      }
      const simulatorOnly = item.requirements.includes("simulator-control");
      if (this.compatibility() === "physical" && simulatorOnly) {
        return false;
      }
      if (this.compatibility() === "simulator" && !simulatorOnly) {
        return false;
      }
      if (this.compatibility() === "station" && item.requirements.some((requirement) => !this.stationCapabilities().includes(requirement))) {
        return false;
      }
      return true;
    });
  }

  selectVisible(): void {
    if (this.active() !== "cases") {
      return;
    }
    for (const item of this.visible()) {
      if (!this.lab.isSelected("case", item.id)) {
        this.lab.toggle({ kind: "case", id: item.id, title: item.title });
      }
    }
  }

  requirementLabel(item: CatalogCase): string {
    return item.requirements.includes("simulator-control") ? "Simulator-only" : "Physical-compatible";
  }

  caseCount(item: CatalogCase | CatalogScenario | CatalogSuite): number | null {
    return "caseIds" in item && item.caseIds.length > 0 ? item.caseIds.length : null;
  }

  timeout(item: CatalogCase | CatalogScenario | CatalogSuite): number | null {
    return "timeoutMs" in item && this.active() === "cases" ? item.timeoutMs : null;
  }

  order(item: CatalogCase | CatalogScenario | CatalogSuite): string | null {
    if ("scenarioIds" in item && this.active() === "suites") {
      return item.scenarioIds.join(" → ");
    }
    if ("caseIds" in item && this.active() === "scenarios") {
      return item.caseIds.join(" → ");
    }
    return null;
  }

  private stationCapabilities(): string[] {
    const simulator = this.simulators().find((item) => item.identity === this.lab.stationId() && item.connected);
    return simulator?.capabilities ?? [];
  }

  text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
}
