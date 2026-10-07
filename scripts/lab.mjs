import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(root, "apps/cli/node_modules/.bin/tsx");
const child = spawn(tsx, [path.join(root, "apps/cli/src/main.ts"), ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, INIT_CWD: process.env.INIT_CWD || process.cwd() },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
