import { Component, input, output } from "@angular/core";

@Component({
  selector: "app-state-block",
  template: `
    @if (loading() && !hasContent()) {
      <p class="empty" role="status">Loading…</p>
    } @else if (error() && !hasContent()) {
      <div class="banner bad" role="alert">
        <p>{{ error() }}</p>
        <button type="button" class="ghost" (click)="retry.emit()">Retry</button>
      </div>
    } @else if (empty()) {
      <p class="empty">{{ emptyText() }}</p>
    }
    @if (error() && hasContent()) {
      <div class="banner warn" role="status">
        <p>Refresh failed. Showing the last loaded data. {{ error() }}</p>
        <button type="button" class="ghost" (click)="retry.emit()">Retry</button>
      </div>
    }
  `,
})
export class StateBlockComponent {
  readonly loading = input(false);
  readonly error = input<string | null>(null);
  readonly empty = input(false);
  readonly emptyText = input("Nothing to show.");
  readonly hasContent = input(false);
  readonly retry = output<void>();
}
