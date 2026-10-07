import { Injectable, signal } from "@angular/core";
import type { SelectionItem, SelectionKind } from "../models";

@Injectable({ providedIn: "root" })
export class LabState {
  readonly stationId = signal("");
  readonly selection = signal<SelectionItem[]>([]);
  readonly importedProfile = signal<Record<string, unknown> | null>(null);
  readonly importedName = signal("");
  readonly overrides = signal<Record<string, string>>({});
  readonly targetMode = signal<"embedded" | "external">("embedded");
  readonly targetUrl = signal("");

  selectOnly(item: SelectionItem): void {
    this.selection.set([item]);
  }

  toggle(item: SelectionItem): void {
    const current = this.selection();
    const exists = current.some((entry) => entry.kind === item.kind && entry.id === item.id);
    this.selection.set(exists ? current.filter((entry) => !(entry.kind === item.kind && entry.id === item.id)) : [...current, item]);
  }

  remove(kind: SelectionKind, id: string): void {
    this.selection.update((current) => current.filter((entry) => !(entry.kind === kind && entry.id === id)));
  }

  clearSelection(): void {
    this.selection.set([]);
  }

  isSelected(kind: SelectionKind, id: string): boolean {
    return this.selection().some((entry) => entry.kind === kind && entry.id === id);
  }

  setOverride(name: string, value: string): void {
    this.overrides.update((current) => ({ ...current, [name]: value }));
  }

  clearOverride(name: string): void {
    this.overrides.update((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
  }

  clearOverrides(): void {
    this.overrides.set({});
  }

  importProfile(value: Record<string, unknown>, name: string): void {
    this.importedProfile.set(value);
    this.importedName.set(name);
  }

  resetProfile(): void {
    this.importedProfile.set(null);
    this.importedName.set("");
    this.overrides.set({});
  }
}
