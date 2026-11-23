import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const EXT_DIR = path.join(ROOT_DIR, "bitbucket-pr-extension");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const MANIFEST_PATH = path.join(EXT_DIR, "manifest.json");

/** Relative paths under the extension dir that must never ship in a sideload zip. */
const PACK_EXCLUDE_SEGMENTS = new Set(["lib", "__MACOSX"]);

/**
 * @param {string} relPosix path relative to EXT_DIR, forward slashes
 */
function shouldExcludeFromPackage(relPosix) {
  if (!relPosix || relPosix.startsWith(".")) {
    return true;
  }
  if (relPosix === ".DS_Store" || relPosix.endsWith("/.DS_Store")) {
    return true;
  }
  const first = relPosix.split("/")[0];
  return PACK_EXCLUDE_SEGMENTS.has(first);
}

/**
 * Collect packable files under EXT_DIR (manifest at zip root).
 * @returns {string[]} posix paths relative to EXT_DIR
 */
function collectExtensionFiles() {
  /** @type {string[]} */
  const files = [];

  /** @param {string} dirAbs @param {string} relPrefix */
  function walk(dirAbs, relPrefix) {
    for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const relPosix = rel.replaceAll(path.sep, "/");
      if (shouldExcludeFromPackage(relPosix)) {
        continue;
      }
      const full = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        files.push(relPosix);
      }
    }
  }

  walk(EXT_DIR, "");
  return files.sort();
}

/**
 * @param {string} outPath
 * @param {string[]} relFiles
 */
function zipWithPython(outPath, relFiles) {
  const pyScript = `
import json, os, sys, zipfile
ext_dir, dst, files_json = sys.argv[1], sys.argv[2], sys.argv[3]
files = json.loads(files_json)
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zf:
    for rel in files:
        full = os.path.join(ext_dir, rel)
        zf.write(full, rel)
`;
  execFileSync(
    "python3",
    ["-c", pyScript, EXT_DIR, outPath, JSON.stringify(relFiles)],
    { stdio: "inherit" }
  );
}

/**
 * @param {string} outPath
 * @param {string[]} relFiles
 */
function zipWithNativeZip(outPath, relFiles) {
  const listFile = path.join(DIST_DIR, ".package-filelist.txt");
  fs.writeFileSync(listFile, relFiles.join("\n"), "utf8");
  try {
    execFileSync(
      "zip",
      ["-r", "-q", outPath, "-@", "-x", "*.DS_Store", "-x", "lib/*", "-x", "lib/**/*"],
      { cwd: EXT_DIR, input: relFiles.join("\n"), stdio: ["pipe", "inherit", "inherit"] }
    );
  } finally {
    if (fs.existsSync(listFile)) {
      fs.unlinkSync(listFile);
    }
  }
}

function printHandoffInstructions(outPath, version) {
  const rel = path.relative(ROOT_DIR, outPath);
  console.log(`\nPackaged ${rel} (${fs.statSync(outPath).size} bytes) — v${version}`);
  console.log("\nShare this zip with your colleague (not the whole git repo).");
  console.log("They should:");
  console.log("  1. Unzip so manifest.json is at the top level of one folder");
  console.log("  2. Open chrome://extensions → enable Developer mode");
  console.log("  3. Load unpacked → select that folder");
  console.log("  4. Open Settings in the popup and add their own API token (never share yours)");
  console.log("\nOptional: include bitbucket-pr-extension/INSTALLATION.md separately for setup steps.");
}

function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`FAIL: missing ${MANIFEST_PATH}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const version = String(manifest.version || "0.0.0").replace(/[^0-9A-Za-z._-]/g, "");
  const outName = `atlassian-hub-v${version}.zip`;
  const outPath = path.join(DIST_DIR, outName);
  const relFiles = collectExtensionFiles();

  if (!relFiles.includes("manifest.json")) {
    console.error("FAIL: manifest.json not found in extension directory.");
    process.exit(1);
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  if (fs.existsSync(outPath)) {
    fs.unlinkSync(outPath);
  }

  try {
    zipWithNativeZip(outPath, relFiles);
  } catch {
    zipWithPython(outPath, relFiles);
  }

  printHandoffInstructions(outPath, version);
}

main();