import { Routes } from "@angular/router";
import { CatalogComponent } from "./pages/catalog.component";
import { OverviewComponent } from "./pages/overview.component";
import { RunDetailComponent } from "./pages/run-detail.component";
import { RunsComponent } from "./pages/runs.component";
import { StationsComponent } from "./pages/stations.component";

export const routes: Routes = [
  { path: "", component: OverviewComponent },
  { path: "stations", component: StationsComponent },
  { path: "catalog", component: CatalogComponent },
  { path: "cases", redirectTo: "catalog", pathMatch: "full" },
  { path: "runs", component: RunsComponent },
  { path: "runs/:id", component: RunDetailComponent },
];
