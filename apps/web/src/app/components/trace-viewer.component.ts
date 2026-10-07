import { Component, effect, inject, input, signal } from "@angular/core";
import { ApiService } from "../core/api.service";
import { copyText } from "../core/download";
import { formatWhen } from "../core/lab-format";
import type { TraceEntry, TracePage } from "../models";
import { JsonViewerComponent } from "./json-viewer.component";

@Component({
  selector: "app-trace-viewer",
  imports: [JsonViewerComponent],
  template: `
    <section class="panel">
      <header class="page-header">
        <div>
          <p class="eyebrow">Protocol trace</p>
          <h2>OCPP frames</h2>
        </div>
        <button type="button" class="ghost" (click)="load(true)">{{ loaded() ? "Refresh" : "Load trace" }}</button>
      </header>
      @if (summary(); as trace) {
        @if (trace.truncated || trace.droppedEntries || trace.truncatedEntries) {
          <p class="banner warn" role="status">Trace is incomplete. Captured {{ trace.capturedEntries }}, dropped {{ trace.droppedEntries }}, shortened {{ trace.truncatedEntries }}. Redaction is best-effort and may not detect every sensitive value.</p>
        } @else if (trace.capturedEntries === 0) {
          <p class="banner warn" role="status">This run has no stored trace. It may predate tracing. Redaction is best-effort.</p>
        } @else {
          <p class="muted">Redaction is best-effort and may not detect arbitrary sensitive values.</p>
        }
      }
      <div class="filters">
        <label>Case <input [value]="caseId()" (input)="caseId.set(inputValue($event))" /></label>
        <label>Action <input [value]="action()" (input)="action.set(inputValue($event))" /></label>
        <label>Direction
          <select [value]="direction()" (change)="direction.set(inputValue($event))">
            <option value="">Any</option>
            <option value="csms-to-charge-point">CSMS → charge point</option>
            <option value="charge-point-to-csms">Charge point → CSMS</option>
          </select>
        </label>
        <label>Message
          <select [value]="messageType()" (change)="messageType.set(inputValue($event))">
            <option value="">Any</option>
            <option>CALL</option>
            <option>CALLRESULT</option>
            <option>CALLERROR</option>
            <option>UNKNOWN</option>
          </select>
        </label>
        <label>Unique ID <input [value]="uniqueId()" (input)="uniqueId.set(inputValue($event))" /></label>
        <label>Payload <input [value]="payloadQuery()" (input)="payloadQuery.set(inputValue($event))" /></label>
        <button type="button" class="ghost" (click)="clearFilters()">Clear filters</button>
        <button type="button" class="ghost" (click)="load(true)">Apply server filters</button>
      </div>
      @if (error()) {
        <p class="banner bad" role="alert">{{ error() }}</p>
      }
      <div class="trace-list">
        @for (entry of visible(); track entry.sequence) {
          <article class="trace-row" [attr.data-direction]="entry.direction" [attr.data-type]="entry.messageType">
            <button type="button" class="trace-summary" (click)="toggle(entry.sequence)" [attr.aria-expanded]="open() === entry.sequence">
              <span>#{{ entry.sequence }}</span>
              <time [attr.datetime]="entry.at" [title]="when(entry.at).utc">{{ when(entry.at).local }}</time>
              <span>{{ directionLabel(entry.direction) }}</span>
              <span>{{ entry.messageType }}</span>
              <span>{{ entry.action || "—" }}</span>
              <code>{{ entry.uniqueId || "—" }}</code>
              <code>{{ entry.caseId || "—" }}</code>
              @if (entry.originalRawBytes || entry.originalPayloadBytes) {
                <span>shortened</span>
              }
            </button>
            @if (open() === entry.sequence) {
              <div class="trace-detail">
                @if (entry.errorCode) {
                  <p>{{ entry.errorCode }} {{ entry.errorDescription }}</p>
                }
                <app-json-viewer [value]="entry.payload ?? null" />
                @if (entry.raw) {
                  <pre class="json-tree">{{ entry.raw }}</pre>
                }
                <button type="button" class="ghost" (click)="copy(stringify(entry.payload ?? null), 'Payload copied')">Copy payload</button>
                <button type="button" class="ghost" (click)="copy(entry.raw || '', 'Raw frame copied')">Copy raw frame</button>
              </div>
            }
          </article>
        } @empty {
          <p class="empty">{{ loaded() ? "No frames match these filters." : "Load the trace to inspect OCPP frames." }}</p>
        }
      </div>
      @if (hasMore()) {
        <button type="button" class="ghost" (click)="load(false)">Load more</button>
      }
      <p class="live" aria-live="polite">{{ notice() }}</p>
    </section>
  `,
})
export class TraceViewerComponent {
  readonly runId = input.required<string>();
  readonly caseFilter = input("");
  private readonly api = inject(ApiService);
  readonly entries = signal<TraceEntry[]>([]);
  readonly summary = signal<TracePage["summary"] | null>(null);
  readonly caseId = signal("");
  readonly action = signal("");
  readonly direction = signal("");
  readonly messageType = signal("");
  readonly uniqueId = signal("");
  readonly payloadQuery = signal("");
  readonly open = signal<number | null>(null);
  readonly error = signal<string | null>(null);
  readonly notice = signal("");
  readonly loaded = signal(false);
  readonly hasMore = signal(false);
  private cursor: number | undefined;

  constructor() {
    effect(() => {
      const value = this.caseFilter();
      if (!value) {
        return;
      }
      this.caseId.set(value);
      this.load(true);
    });
  }

  load(reset: boolean): void {
    if (reset) {
      this.entries.set([]);
      this.cursor = undefined;
    }
    this.api.trace(this.runId(), {
      caseId: this.caseId() || undefined,
      action: this.action() || undefined,
      direction: this.direction() || undefined,
      messageType: this.messageType() || undefined,
      limit: 100,
      afterSequence: this.cursor,
    }).subscribe({
      next: (page) => {
        this.summary.set(page.summary);
        this.entries.update((current) => reset ? page.entries : [...current, ...page.entries]);
        this.hasMore.set(Boolean(page.page?.hasMore));
        this.cursor = page.page?.nextAfterSequence ?? undefined;
        this.loaded.set(true);
        this.error.set(null);
      },
      error: () => this.error.set("The trace could not be loaded."),
    });
  }

  visible(): TraceEntry[] {
    const unique = this.uniqueId().trim().toLowerCase();
    const payload = this.payloadQuery().trim().toLowerCase();
    return this.entries().filter((entry) => {
      if (unique && !(entry.uniqueId ?? "").toLowerCase().includes(unique)) {
        return false;
      }
      if (payload && !JSON.stringify(entry.payload ?? "").toLowerCase().includes(payload)) {
        return false;
      }
      return true;
    });
  }

  clearFilters(): void {
    this.caseId.set("");
    this.action.set("");
    this.direction.set("");
    this.messageType.set("");
    this.uniqueId.set("");
    this.payloadQuery.set("");
  }

  toggle(sequence: number): void {
    this.open.set(this.open() === sequence ? null : sequence);
  }

  async copy(value: string, announcement: string): Promise<void> {
    await copyText(value);
    this.notice.set(announcement);
  }

  stringify(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }

  directionLabel(direction: TraceEntry["direction"]): string {
    return direction === "csms-to-charge-point" ? "CSMS → charge point" : "Charge point → CSMS";
  }

  when(value: string): { local: string; utc: string } {
    return formatWhen(value);
  }

  inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
}
