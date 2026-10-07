import { Component, input } from "@angular/core";

@Component({
  selector: "app-status-pill",
  template: `<span class="status" [attr.data-status]="status()">{{ label() || status() }}</span>`,
})
export class StatusPillComponent {
  readonly status = input.required<string>();
  readonly label = input("");
}
