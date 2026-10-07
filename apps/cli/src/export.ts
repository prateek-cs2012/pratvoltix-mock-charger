import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { assertSafeRunId, type RenderedArtifact } from "@pratvoltix/test-reporting";
import { CliError } from "./args.js";

const KNOWN = new Set(["junit.xml", "manifest.json", "run.json", "summary.txt", "trace-summary.json", "trace.ndjson"]);

export async function writeArtifacts(
  outputRoot: string,
  runId: string,
  files: RenderedArtifact[],
  overwrite: boolean,
  baseDir = process.env.INIT_CWD ?? process.cwd(),
): Promise<string> {
  try {
    assertSafeRunId(runId);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : "Unsafe run id.", 4);
  }
  for (const file of files) {
    if (!KNOWN.has(file.name) || file.name.includes("/") || file.name.includes("\\")) {
      throw new CliError(`Refusing to write unknown artifact "${file.name}".`, 4);
    }
  }
  const root = path.resolve(baseDir, outputRoot);
  try {
    await mkdir(root, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "mkdir failed";
    throw new CliError(`Cannot create artifact directory ${outputRoot}: ${message}`, 4);
  }
  const rootReal = await realpath(root);
  const destination = path.join(rootReal, runId);
  if (destination !== path.join(rootReal, runId) || !destination.startsWith(rootReal + path.sep)) {
    throw new CliError("Artifact path escapes the output directory.", 4);
  }
  let created = false;
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink()) {
      throw new CliError(`Run directory ${runId} is a symbolic link.`, 4);
    }
    if (!existing.isDirectory()) {
      throw new CliError(`Run path ${runId} exists and is not a directory.`, 4);
    }
    if (!overwrite) {
      throw new CliError(`Run bundle ${destination} already exists. Pass --overwrite to replace the known artifact files.`, 4);
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    if (!isEnoent(error)) {
      throw new CliError(error instanceof Error ? error.message : "Cannot inspect the run directory.", 4);
    }
    await mkdir(destination);
    const createdStat = await lstat(destination);
    if (createdStat.isSymbolicLink() || !createdStat.isDirectory()) {
      throw new CliError(`Run directory ${runId} is not a real directory.`, 4);
    }
    created = true;
  }

  const temps: string[] = [];
  const written: string[] = [];
  try {
    for (const file of files) {
      const finalPath = path.join(destination, file.name);
      const temporary = path.join(destination, `.${file.name}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
      temps.push(temporary);
      const handle = await open(temporary, "w", 0o644);
      try {
        await handle.writeFile(file.contents, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameFile(temporary, finalPath);
      temps.pop();
      written.push(finalPath);
    }
  } catch (error) {
    await Promise.all(temps.map((temporary) => unlink(temporary).catch(() => undefined)));
    if (created) {
      await Promise.all(written.map((file) => unlink(file).catch(() => undefined)));
      await rmdir(destination).catch(() => undefined);
    }
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(error instanceof Error ? error.message : "Artifact write failed.", 4);
  }
  return destination;
}

async function renameFile(from: string, to: string): Promise<void> {
  try {
    const existing = await lstat(to);
    if (existing.isSymbolicLink()) {
      throw new CliError(`Refusing to replace symbolic link ${path.basename(to)}.`, 4);
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    if (!isEnoent(error)) {
      throw error;
    }
  }
  await rename(from, to);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function removeTree(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
