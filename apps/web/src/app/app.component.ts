import { Component } from "@angular/core";
import { RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";

@Component({
  selector: "app-root",
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand-row">
          <a class="brand" routerLink="/">
            <span class="mark" aria-hidden="true"></span>
            <span>
              <strong>Pratvoltix</strong>
              <small>OCPP Lab</small>
            </span>
          </a>
          <button type="button" class="menu-toggle" (click)="menuOpen = !menuOpen" [attr.aria-expanded]="menuOpen" aria-controls="primary-nav">Menu</button>
        </div>
        <nav id="primary-nav" [class.open]="menuOpen">
          <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }" (click)="menuOpen = false">Overview</a>
          <a routerLink="/stations" routerLinkActive="active" (click)="menuOpen = false">Stations</a>
          <a routerLink="/catalog" routerLinkActive="active" (click)="menuOpen = false">Catalog</a>
          <a routerLink="/runs" routerLinkActive="active" (click)="menuOpen = false">Runs</a>
        </nav>
        <p class="sidebar-note">OCPP 1.6-J over WebSocket. Execution stays in the headless lab.</p>
      </aside>
      <main class="content">
        <router-outlet />
      </main>
    </div>
  `,
})
export class AppComponent {
  menuOpen = false;
}
