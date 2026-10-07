import { Component, input } from "@angular/core";
import type { RunPreview } from "../models";

@Component({
  selector: "app-plan-preview",
  template: `
    @if (preview(); as plan) {
      <section class="panel" aria-live="polite">
        <header class="page-header">
          <div>
            <p class="eyebrow">Execution plan</p>
            <h2>{{ plan.plan.cases.length }} cases · {{ plan.effectiveProfile.name }}</h2>
          </div>
          <p class="muted">Up to {{ plan.estimatedTimeoutMs }} ms · {{ plan.effectiveProfile.name }} schema {{ plan.effectiveProfile.schemaVersion }}</p>
        </header>
        @if (plan.effectiveProfile.overridden.length) {
          <p>Overrides @for (name of plan.effectiveProfile.overridden; track name) { <code>{{ name }}={{ plan.effectiveProfile.parameters[name] }}</code> }</p>
        }
        @if (!plan.station.connected) {
          <p class="banner warn" role="status">{{ plan.station.identity }} is not connected on OCPP. The plan can be previewed, but it cannot run.</p>
        }
        @if (!plan.compatibility.compatible) {
          <div class="banner bad" role="alert">
            @for (gap of plan.compatibility.missingCapabilities; track gap.capability) {
              <p>Missing {{ gap.capability }} for {{ gap.caseIds.join(", ") }}.</p>
            }
          </div>
        }
        <ol class="plan-list">
          @for (item of plan.plan.cases; track item.id; let index = $index) {
            <li>
              <strong>{{ index + 1 }}. {{ item.title }}</strong>
              <code>{{ item.id }}</code>
              <span class="muted">{{ item.timeoutMs }} ms</span>
              <span class="muted">{{ origins(item) }}</span>
              @if (item.requirements.length) {
                <span class="tags"><span>{{ item.requirements.join(", ") }}</span></span>
              }
            </li>
          }
        </ol>
      </section>
    }
  `,
})
export class PlanPreviewComponent {
  readonly preview = input<RunPreview | null>(null);

  origins(item: RunPreview["plan"]["cases"][number]): string {
    return item.origins.map((origin) => `${origin.type} ${origin.id}`).join(", ") || "direct case";
  }
}
