#!/usr/bin/env tsx

import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";

const PROJECT_ROOT = resolve(".");
const GENOME_PATH = resolve("synap-reference.genome.ts");
const OUTPUT_DIR = join(tmpdir(), "synap-generated");
const INCLUDE_DIRECTORIES = ["apps", "packages", "scripts"];
const IGNORE_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".turbo",
  ".pnpm-store",
]);

function logHeading(title: string): void {
  console.log(`\n==== ${title} ====`);
}

interface RunOptions {
  cwd?: string;
  shell?: boolean;
}

function runCommand(
  command: string,
  args: string[],
  options: RunOptions = {}
): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? PROJECT_ROOT,
    stdio: "inherit",
    env: process.env,
    shell: options.shell ?? false,
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

type PackageManager = "pnpm" | "yarn" | "npm";

function detectPackageManager(projectDir: string): PackageManager {
  const packageJsonPath = join(projectDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    return "pnpm";
  }

  try {
    const contents = readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(contents) as { packageManager?: string };
    const manager = pkg.packageManager?.toLowerCase();
    if (manager?.startsWith("yarn")) {
      return "yarn";
    }
    if (manager?.startsWith("npm")) {
      return "npm";
    }
    if (manager?.startsWith("pnpm")) {
      return "pnpm";
    }
  } catch {
    // ignore and fall back
  }

  return "pnpm";
}

function getInstallCommand(manager: PackageManager): [string, string[]] {
  switch (manager) {
    case "yarn":
      return ["yarn", ["install"]];
    case "npm":
      return ["npm", ["install"]];
    case "pnpm":
    default:
      return ["pnpm", ["install"]];
  }
}

function getTestCommand(manager: PackageManager): [string, string[]] {
  switch (manager) {
    case "yarn":
      return ["yarn", ["test"]];
    case "npm":
      return ["npm", ["test"]];
    case "pnpm":
    default:
      return ["pnpm", ["test"]];
  }
}

function hasScript(projectDir: string, scriptName: string): boolean {
  const packageJsonPath = join(projectDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const contents = readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(contents) as { scripts?: Record<string, unknown> };
    return typeof pkg.scripts?.[scriptName] === "string";
  } catch {
    return false;
  }
}

function collectFiles(root: string): Set<string> {
  const files = new Set<string>();

  for (const directory of INCLUDE_DIRECTORIES) {
    const absoluteDir = join(root, directory);
    if (!existsSync(absoluteDir)) {
      continue;
    }
    walk(absoluteDir, absoluteDir, files, directory);
  }

  return files;
}

function walk(
  current: string,
  base: string,
  files: Set<string>,
  prefix: string
): void {
  const entries = readdirSync(current);
  for (const entry of entries) {
    if (IGNORE_DIRECTORIES.has(entry)) {
      continue;
    }

    const absolutePath = join(current, entry);
    const stats = statSync(absolutePath);

    if (stats.isDirectory()) {
      walk(absolutePath, base, files, prefix);
    } else {
      const relativePath = relative(base, absolutePath);
      files.add(join(prefix, relativePath));
    }
  }
}

function ensureCleanOutput(): void {
  if (existsSync(OUTPUT_DIR)) {
    rmSync(OUTPUT_DIR, { recursive: true, force: true });
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

function resolveGeneratedProjectRoot(baseDir: string): string {
  if (existsSync(join(baseDir, "package.json"))) {
    return baseDir;
  }

  const entries = readdirSync(baseDir, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory()
  );
  if (entries.length === 1) {
    const childDir = join(baseDir, entries[0].name);
    if (existsSync(join(childDir, "package.json"))) {
      return childDir;
    }
    return childDir;
  }

  throw new Error(
    `Unable to determine generated project root within ${baseDir}.`
  );
}

async function main(): Promise<void> {
  logHeading("Preparing output directory");
  ensureCleanOutput();

  logHeading("Generating project from genome");
  const cliExecutable = process.env.ARCHITECH_CLI?.trim();
  if (cliExecutable && cliExecutable.length > 0) {
    runCommand(
      cliExecutable,
      ["new", "--genome", GENOME_PATH, "synap-generated"],
      { shell: true, cwd: OUTPUT_DIR }
    );
  } else {
    try {
      runCommand(
        "npx",
        [
          "@thearchitech/cli",
          "new",
          "--genome",
          GENOME_PATH,
          "synap-generated",
        ],
        { cwd: OUTPUT_DIR }
      );
    } catch (error) {
      console.error(
        "\nUnable to download @thearchitech/cli via npx. Set ARCHITECH_CLI to a local CLI executable and re-run this script."
      );
      throw error;
    }
  }

  const GENERATED_PROJECT_DIR = resolveGeneratedProjectRoot(OUTPUT_DIR);

  const packageManager = detectPackageManager(GENERATED_PROJECT_DIR);
  const [installCommand, installArgs] = getInstallCommand(packageManager);
  const [testCommand, testArgs] = getTestCommand(packageManager);

  logHeading("Installing dependencies in generated project");
  runCommand(installCommand, installArgs, { cwd: GENERATED_PROJECT_DIR });

  if (hasScript(GENERATED_PROJECT_DIR, "test")) {
    logHeading("Running tests in generated project");
    runCommand(testCommand, testArgs, { cwd: GENERATED_PROJECT_DIR });
  } else {
    console.log('Skipping tests: no "test" script defined in package.json.');
  }

  logHeading("Comparing directory structure");
  const manualFiles = collectFiles(PROJECT_ROOT);
  const generatedFiles = collectFiles(GENERATED_PROJECT_DIR);

  const missingInGenerated = [...manualFiles]
    .filter((file) => !generatedFiles.has(file))
    .sort();
  const newInGenerated = [...generatedFiles]
    .filter((file) => !manualFiles.has(file))
    .sort();

  if (missingInGenerated.length === 0 && newInGenerated.length === 0) {
    console.log("Directory structures match for monitored folders.");
  } else {
    if (missingInGenerated.length > 0) {
      console.log("\nFiles missing from generated project:");
      missingInGenerated.forEach((file) => console.log(`  - ${file}`));
    }
    if (newInGenerated.length > 0) {
      console.log("\nNew files in generated project (not in manual backend):");
      newInGenerated.forEach((file) => console.log(`  + ${file}`));
    }
  }

  logHeading("Validation complete");
}

main().catch((error) => {
  console.error("\nGeneration validation failed:", error);
  process.exit(1);
});
