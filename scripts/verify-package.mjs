// Package contract verification for omp-deepseek-anchor.
// Modeled on dsh-routing-suite's scripts/verify-package.mjs: checks license,
// forbids install lifecycle scripts, verifies identity markers, and compares
// the exact packed file set against an allowlist.

import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

// Exact file set the published tarball must contain (excluding package.json,
// which bun/npm always include and which is verified in place below).
const EXPECTED_FILES = [
  ".dsh-parity-verification.json",
  "AGENTS.md",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "SOURCE_PROVENANCE.md",
  "src/anchor.ts",
  "src/index.ts",
].sort();

for (const path of EXPECTED_FILES) {
  await access(new URL(`../${path}`, import.meta.url));
}

if (manifest.name !== "omp-deepseek-anchor") throw new Error("package name mismatch");
if (manifest.license !== "MIT") throw new Error("package license must be MIT");
if (manifest.scripts?.preinstall || manifest.scripts?.install || manifest.scripts?.postinstall) {
  throw new Error("install lifecycle scripts are forbidden");
}
if (JSON.stringify(manifest.omp?.extensions) !== JSON.stringify(["./src/index.ts"])) {
  throw new Error("omp extension declaration mismatch");
}
if (JSON.stringify(manifest.files) !== JSON.stringify([
  "src",
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  ".dsh-parity-verification.json",
  "AGENTS.md",
  "SOURCE_PROVENANCE.md",
])) {
  throw new Error("package files allowlist drifted from the verified list");
}

const host = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const pure = await readFile(new URL("../src/anchor.ts", import.meta.url), "utf8");
if (!host.includes("export default function deepSeekAnchor")) {
  throw new Error("Host identity marker missing (default factory export)");
}
if (!host.includes("deepseek-anchor-status")) throw new Error("status command identity mismatch");
if (host.includes("process.env") && !host.includes("OMP_DEEPSEEK_ANCHOR")) {
  throw new Error("unexpected env access in Host wiring");
}

// Pure anchor module must stay free of the pi runtime so it remains
// unit-testable without a harness (mirror of router.mjs's dependency freedom).
if (/pi\.|ExtensionAPI/.test(pure)) throw new Error("pure anchor module leaked pi runtime access");

let output;
try {
  output = execFileSync("bun", ["pm", "pack", "--dry-run", "--ignore-scripts"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
} catch (error) {
  throw new Error(`bun pm pack failed: ${String(error)}`);
}
const packed = [...output.matchAll(/^packed\s+\S+\s+(\S+)$/gm)]
  .map((match) => match[1])
  .sort();
const expectedPacked = [...EXPECTED_FILES, "package.json"].sort();
if (JSON.stringify(packed) !== JSON.stringify(expectedPacked)) {
  const missing = expectedPacked.filter((path) => !packed.includes(path));
  const extra = packed.filter((path) => !expectedPacked.includes(path));
  throw new Error(`unexpected pack file set; missing=[${missing.join(", ")}] extra=[${extra.join(", ")}]`);
}

// Prove a real tarball is produced and non-empty.
const packDirectory = await mkdtemp(join(tmpdir(), "omp-deepseek-anchor-pack-"));
try {
  execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--destination", packDirectory], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  const files = await readdir(packDirectory);
  const archive = files.find((file) => file.endsWith(".tgz"));
  if (!archive) throw new Error("bun did not produce a tarball under --destination");
  const info = await stat(join(packDirectory, archive));
  if (!info.isFile() || info.size < 1) throw new Error("packed tarball is empty");
  process.stdout.write(`verified exact MIT OMP plugin tarball (${packed.length} files, ${info.size} bytes)\n`);
} finally {
  await rm(packDirectory, { recursive: true, force: true });
}