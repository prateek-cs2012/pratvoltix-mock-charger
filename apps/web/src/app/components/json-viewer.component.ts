import { Component, input } from "@angular/core";

@Component({
  selector: "app-json-viewer",
  template: `<pre class="json-tree">{{ format(value(), 0) }}</pre>`,
})
export class JsonViewerComponent {
  readonly value = input<unknown>(null);
  readonly format = formatJson;
}

export function formatJson(value: unknown, depth: number): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (depth > 2) {
      return `[${value.length} items]`;
    }
    return `[\n${value.map((item) => `${"  ".repeat(depth + 1)}${formatJson(item, depth + 1)}`).join(",\n")}\n${"  ".repeat(depth)}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (depth > 2) {
      return `{${entries.length} fields}`;
    }
    return `{\n${entries.map(([key, item]) => `${"  ".repeat(depth + 1)}${JSON.stringify(key)}: ${formatJson(item, depth + 1)}`).join(",\n")}\n${"  ".repeat(depth)}}`;
  }
  return JSON.stringify(String(value));
}
