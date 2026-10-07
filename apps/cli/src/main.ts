import { executeCli } from "./cli.js";

const exitCode = await executeCli(process.argv.slice(2));
process.exit(exitCode);
