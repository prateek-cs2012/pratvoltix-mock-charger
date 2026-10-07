import { Component, DestroyRef, inject, signal } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { ActivatedRoute } from "@angular/router";
import { catchError, of, timer } from "rxjs";
import { filter, switchMap, takeWhile } from "rxjs/operators";
import { ApiService } from "../core/api.service";
import { copyText, downloadText } from "../core/download";
import { formatDuration, formatWhen, safeDownloadName, traceNdjson } from "../core/lab-format";
import type { TestRun, TraceEntry } from "../models";
import { JsonViewerComponent } from "../components/json-viewer.component";
import { StateBlockComponent } from "../components/state-block.component";
import { StatusPillComponent } from "../components/status-pill.component";
import { TraceViewerComponent } from "../components/trace-viewer.component";

@Component({
  selector: "app-run-detail",
  imports: [JsonViewerComponent, StateBlockComponent, StatusPillComponent, TraceViewerComponent],
  template: `
    <app-state-block [loading]="loading()" [error]="error()" [hasContent]="run() !== null" (retry)="load()" />
    @if (run(); as current) {
      <header class="page-header">
        <div>
          <p class="eyebrow">Run</p>
          <h1><code>{{ current.id }}</code></h1>
          <p class="muted">{{ current.chargePointIdentity }} · catalog {{ current.plan?.catalogVersion || "unknown" }} · profile {{ current.profile?.name || "none" }} schema {{ current.profile?.schemaVersion || "—" }}</p>
        </div>
        <app-status-pill [status]="current.status" />
      </header>
      @if (current.target) {
        <section class="sut" aria-label="System under test">
          <p class="eyebrow">System under test</p>
          <p>{{ current.target.mode }} · source {{ current.target.configurationSource }} · station {{ current.target.stationIdentity }}</p>
          <p>Template <code>{{ current.target.urlTemplate }}</code></p>
          <p>Endpoint <code>{{ current.target.resolvedEndpoint }}</code></p>
          <p>Subprotocol requested {{ current.target.requestedSubprotocol }}, negotiated {{ current.target.negotiatedSubprotocol || "not negotiated" }}</p>
        </section>
      }
      <p aria-live="polite" class="live">Status {{ current.status }}. Last refresh {{ refreshed() }}. {{ notice() }}</p>
      <button type="button" class="ghost" (click)="copy(current.id)">Copy run ID</button>
      <button type="button" class="ghost" (click)="load()">Refresh</button>
      <section class="stats">
        <article><span>Started</span><strong class="time" [title]="when(current.startedAt).utc">{{ when(current.startedAt).local }}</strong></article>
        <article><span>Finished</span><strong class="time" [title]="when(current.finishedAt).utc">{{ when(current.finishedAt).local }}</strong></article>
        <article><span>Duration</span><strong class="time">{{ duration(current) }}</strong></article>
        <article><span>Passed</span><strong>{{ current.summary.passed }}</strong></article>
        <article><span>Failed</span><strong>{{ current.summary.failed }}</strong></article>
        <article><span>Errors</span><strong>{{ current.summary.error }}</strong></article>
        <article><span>Trace</span><strong class="time">{{ current.trace?.capturedEntries ?? 0 }} captured, {{ current.trace?.droppedEntries ?? 0 }} dropped</strong></article>
      </section>
      <section class="panel">
        <h2>Requested</h2>
        <p>{{ requested(current) }}</p>
        <p class="muted">{{ current.trace?.truncated ? "Trace is truncated." : "Trace completeness follows the stored summary." }}</p>
      </section>
      <section class="panel">
        <h2>Execution plan</h2>
        @if (current.plan) {
          <ol class="plan-list">
            @for (item of current.plan.cases; track item.id; let index = $index) {
              <li>
                <strong>{{ index + 1 }}. {{ item.title }}</strong>
                <code>{{ item.id }}</code>
                <span>{{ resultStatus(current, item.id) }}</span>
                <span class="muted">{{ item.timeoutMs }} ms · {{ item.origins.map(origin => origin.type + " " + origin.id).join(", ") }}</span>
              </li>
            }
          </ol>
        } @else {
          <p class="muted">This historical run has no stored plan snapshot.</p>
        }
      </section>
      <section class="result-list">
        @for (result of current.results; track result.id) {
          <article class="panel">
            <header>
              <h2>{{ result.title }}</h2>
              <app-status-pill [status]="result.status" />
              <span>{{ result.durationMs }} ms</span>
            </header>
            @if (result.error) {
              <p>{{ result.error }}</p>
            }
            @if (expanded(result.id, result.status)) {
              <ul class="transcript">
                @for (log of result.logs; track log.at + log.message) {
                  <li [attr.data-level]="log.level"><time [title]="when(log.at).utc">{{ when(log.at).local }}</time><span>{{ log.level }} {{ log.message }}</span></li>
                }
              </ul>
              <button type="button" class="ghost" (click)="showFrames(result.id)">Show protocol frames</button>
            }
            <button type="button" class="ghost" (click)="toggle(result.id, result.status)">{{ expanded(result.id, result.status) ? "Collapse" : "Expand" }}</button>
          </article>
        }
      </section>
      <section class="panel">
        <h2>Effective profile</h2>
        <p class="muted">This is the profile stored with the run. Profiles are test configuration, not secret storage.</p>
        @if (current.profile?.parameters) {
          <dl>
            @for (entry of profileRows(current); track entry.name) {
              <div><dt>{{ entry.name }}{{ entry.overridden ? " (override)" : "" }}</dt><dd>{{ entry.value }}</dd></div>
            }
          </dl>
          <button type="button" class="ghost" (click)="rawProfile.set(!rawProfile())">{{ rawProfile() ? "Hide JSON" : "Raw JSON" }}</button>
          @if (rawProfile()) {
            <app-json-viewer [value]="current.profile" />
          }
        } @else {
          <p class="muted">This historical run has no stored profile snapshot.</p>
        }
      </section>
      <app-trace-viewer [runId]="current.id" [caseFilter]="frameCase()" />
      <section class="panel">
        <h2>Artifacts</h2>
        <p class="muted">The canonical JUnit bundle is produced by the headless CLI, not the browser.</p>
        <pre class="endpoint">pnpm lab -- artifacts export {{ current.id }} --output artifacts/ocpp</pre>
        <pre class="endpoint">pnpm lab -- artifacts export {{ current.id }} --output artifacts/ocpp --require-trace --fail-on-truncated-trace</pre>
        <button type="button" class="ghost" (click)="copy('pnpm lab -- artifacts export ' + current.id + ' --output artifacts/ocpp')">Copy export command</button>
        <button type="button" class="ghost" (click)="downloadRun(current)">Download run.json</button>
        <button type="button" class="ghost" (click)="downloadTrace(current)">Download trace.ndjson</button>
        @if (downloadError()) {
          <p class="banner bad" role="alert">{{ downloadError() }}</p>
        }
      </section>
    }
  `,
})
export class RunDetailComponent {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  readonly run = signal<TestRun | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly refreshed = signal("");
  readonly rawProfile = signal(false);
  readonly downloadError = signal("");
  readonly notice = signal("");
  private readonly opened = signal<Record<string, boolean>>({});
  readonly frameCase = signal("");

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.route.paramMap.pipe(
      switchMap((params) => {
        const id = params.get("id") ?? "";
        this.loading.set(true);
        return timer(0, 2000).pipe(
          switchMap(() => this.api.run(id).pipe(catchError(() => {
            this.loading.set(false);
            this.error.set(this.run() ? "Refresh failed. Showing the last run snapshot." : "The lab API is unavailable.");
            return of(null);
          }))),
          filter((run): run is TestRun => run !== null),
          takeWhile((run) => run.status === "queued" || run.status === "running", true),
        );
      }),
      takeUntilDestroyed(destroyRef),
    ).subscribe({
      next: (run) => {
        this.run.set(run);
        this.loading.set(false);
        this.error.set(null);
        this.refreshed.set(formatWhen(new Date().toISOString()).local);
        if (run.status !== "queued" && run.status !== "running") {
          this.loading.set(false);
        }
      },
      error: () => {
        this.loading.set(false);
        this.error.set(this.run() ? "Refresh failed. Showing the last run snapshot." : "The lab API is unavailable.");
      },
    });
  }

  load(): void {
    const id = this.route.snapshot.paramMap.get("id");
    if (!id) {
      return;
    }
    this.api.run(id).subscribe({
      next: (run) => {
        this.run.set(run);
        this.error.set(null);
        this.refreshed.set(formatWhen(new Date().toISOString()).local);
      },
      error: () => this.error.set(this.run() ? "Refresh failed. Showing the last run snapshot." : "The lab API is unavailable."),
    });
  }

  expanded(id: string, status: string): boolean {
    const explicit = this.opened()[id];
    if (explicit !== undefined) {
      return explicit;
    }
    return status === "failed" || status === "error";
  }

  toggle(id: string, status: string): void {
    const current = this.expanded(id, status);
    this.opened.update((state) => ({ ...state, [id]: !current }));
  }

  showFrames(caseId: string): void {
    this.frameCase.set(caseId);
    document.querySelector("app-trace-viewer")?.scrollIntoView({ block: "start" });
  }

  resultStatus(run: TestRun, id: string): string {
    return run.results.find((result) => result.id === id)?.status ?? "pending";
  }

  profileRows(run: TestRun): Array<{ name: string; value: string; overridden: boolean }> {
    const parameters = run.profile?.parameters ?? {};
    const overridden = new Set(run.profile?.overridden ?? []);
    return Object.entries(parameters).map(([name, value]) => ({ name, value: String(value), overridden: overridden.has(name) }));
  }

  requested(run: TestRun): string {
    const selection = run.selection;
    if (!selection) {
      return run.caseIds.join(", ") || "Unknown selection";
    }
    return [`cases ${selection.caseIds.join(", ") || "none"}`, `scenarios ${selection.scenarioIds.join(", ") || "none"}`, `suites ${selection.suiteIds.join(", ") || "none"}`].join(" · ");
  }

  async copy(value: string): Promise<void> {
    await copyText(value);
    this.notice.set("Copied");
  }

  downloadRun(run: TestRun): void {
    downloadText(safeDownloadName(run.id, "json"), `${JSON.stringify(run, null, 2)}\n`, "application/json");
  }

  downloadTrace(run: TestRun): void {
    this.downloadError.set("");
    const entries: TraceEntry[] = [];
    const pull = (after?: number) => {
      this.api.trace(run.id, { limit: 500, afterSequence: after }).subscribe({
        next: (page) => {
          entries.push(...page.entries);
          if (page.page?.hasMore && page.page.nextAfterSequence != null) {
            pull(page.page.nextAfterSequence);
            return;
          }
          downloadText(safeDownloadName(run.id, "ndjson"), traceNdjson(entries as unknown as Array<Record<string, unknown>>), "application/x-ndjson");
        },
        error: () => this.downloadError.set("The trace could not be completely fetched, so the NDJSON file was not saved."),
      });
    };
    pull();
  }

  when(value: string | null): { local: string; utc: string } {
    return formatWhen(value);
  }

  duration(run: TestRun): string {
    return formatDuration(run.startedAt, run.finishedAt);
  }
}
