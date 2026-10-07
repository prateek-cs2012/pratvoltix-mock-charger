import { Component, inject, input, signal } from "@angular/core";
import { localOverrideError } from "../core/lab-format";
import { LabState } from "../core/lab-state.service";
import type { ProfileCatalog } from "../models";

@Component({
  selector: "app-profile-editor",
  template: `
    <section class="panel">
      <header class="page-header">
        <div>
          <p class="eyebrow">Profile</p>
          <h2>{{ lab.importedName() || "default-ocpp16" }}</h2>
        </div>
        <button type="button" class="ghost" (click)="lab.resetProfile()">Reset to defaults</button>
      </header>
      <p class="muted">{{ catalog().notice }}</p>
      <label class="file">
        Import JSON profile
        <input type="file" accept="application/json,.json" (change)="importFile($event)" />
      </label>
      @if (importError()) {
        <p class="banner bad" role="alert">{{ importError() }}</p>
      }
      <div class="field-grid">
        @for (spec of catalog().parameters; track spec.name) {
          <label>
            <span>{{ spec.name }}</span>
            <small>{{ spec.description }} Default {{ spec.default }}. {{ constraint(spec) }}</small>
            <input
              [attr.inputmode]="spec.type === 'integer' ? 'numeric' : 'text'"
              [value]="lab.overrides()[spec.name] ?? ''"
              [attr.aria-invalid]="error(spec) ? true : null"
              (input)="edit(spec.name, $event)"
            />
            @if (lab.overrides()[spec.name]) {
              <button type="button" class="ghost" (click)="lab.clearOverride(spec.name)">Reset {{ spec.name }}</button>
            }
            @if (error(spec); as message) {
              <span class="field-error" role="alert">{{ message }}</span>
            }
          </label>
        }
      </div>
    </section>
  `,
})
export class ProfileEditorComponent {
  readonly catalog = input.required<ProfileCatalog>();
  readonly lab = inject(LabState);
  readonly importError = signal("");

  edit(name: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (value.length === 0) {
      this.lab.clearOverride(name);
      return;
    }
    this.lab.setOverride(name, value);
  }

  error(spec: ProfileCatalog["parameters"][number]): string | null {
    return localOverrideError(spec, this.lab.overrides()[spec.name] ?? "");
  }

  constraint(spec: ProfileCatalog["parameters"][number]): string {
    if (spec.type === "integer" && spec.minimum !== undefined && spec.maximum !== undefined) {
      return `Integer ${spec.minimum}–${spec.maximum}.`;
    }
    if (spec.maxLength) {
      return `At most ${spec.maxLength} characters.`;
    }
    return "";
  }

  importFile(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          this.importError.set("Profile file must be a JSON object.");
          return;
        }
        const record = parsed as Record<string, unknown>;
        const name = typeof record["name"] === "string" ? record["name"] : file.name;
        this.lab.importProfile(record, name);
        this.importError.set("");
      } catch {
        this.importError.set("Profile file is not valid JSON.");
      }
    };
    reader.readAsText(file);
  }
}
