import { cases } from "./cases/index.js";
import { createCatalog, type CatalogSelection, type ExecutionPlan } from "./definitions.js";
import { profileCatalog } from "./profile.js";
import { scenarios } from "./scenarios/index.js";
import { suites } from "./suites/index.js";

export const CATALOG_VERSION = "1";

export const catalog = createCatalog({
  version: CATALOG_VERSION,
  cases,
  scenarios,
  suites,
});

export const testCases = catalog.cases;

export function listTestCases() {
  return catalog.listCases();
}

export function describeCatalog() {
  return {
    ...catalog.describe(),
    profile: profileCatalog(),
  };
}

export function resolveSelection(selection: CatalogSelection): ExecutionPlan {
  return catalog.resolve(selection);
}
