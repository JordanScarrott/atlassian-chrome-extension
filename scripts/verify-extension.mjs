import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const EXT_DIR = path.join(ROOT_DIR, "bitbucket-pr-extension");
const MANIFEST_PATH = path.join(EXT_DIR, "manifest.json");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FORBIDDEN_PATTERNS = [
  { label: "window.alert(", regex: /\bwindow\.alert\s*\(/ },
  { label: "unescape(", regex: /\bunescape\s*\(/ }
];

/**
 * Recursively collect files matching a predicate under a directory.
 * @param {string} dir
 * @param {(name: string) => boolean} predicate
 * @returns {string[]}
 */
function walkFiles(dir, predicate) {
  const results = [];
  if (!fs.existsSync(dir)) {
    return results;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath, predicate));
    } else if (entry.isFile() && predicate(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Validate PNG signature and IHDR dimensions.
 * @param {string} filePath
 * @param {number} expectedSize
 * @param {string} label
 * @param {string[]} errors
 */
function validatePngIcon(filePath, expectedSize, label, errors) {
  if (!fs.existsSync(filePath)) {
    errors.push(`Missing icon file for ${label}: ${path.relative(ROOT_DIR, filePath)}`);
    return;
  }

  const buf = fs.readFileSync(filePath);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    errors.push(`Invalid PNG signature in ${path.relative(ROOT_DIR, filePath)}`);
    return;
  }

  const chunkType = buf.subarray(12, 16).toString("ascii");
  if (chunkType !== "IHDR") {
    errors.push(`Missing IHDR chunk in ${path.relative(ROOT_DIR, filePath)}`);
    return;
  }

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (Number.isFinite(expectedSize) && (width !== expectedSize || height !== expectedSize)) {
    errors.push(
      `Icon dimension mismatch for ${label} (${path.relative(ROOT_DIR, filePath)}): expected ${expectedSize}x${expectedSize}, got ${width}x${height}`
    );
  }
}

function main() {
  const errors = [];

  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`FAIL: manifest.json not found at ${MANIFEST_PATH}`);
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch (err) {
    console.error(`FAIL: Invalid JSON in manifest.json: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (manifest.manifest_version !== 3) {
    errors.push(`manifest_version must be 3 (got ${String(manifest.manifest_version)})`);
  }

  if (!manifest.name || !manifest.version) {
    errors.push("manifest.json must declare non-empty name and version");
  }

  // Validate declared icons in both `icons` and `action.default_icon`
  const iconEntries = [];
  if (manifest.icons && typeof manifest.icons === "object") {
    for (const [sizeKey, relPath] of Object.entries(manifest.icons)) {
      iconEntries.push([`icons.${sizeKey}`, Number(sizeKey), relPath]);
    }
  } else {
    errors.push("manifest.json is missing `icons` object");
  }

  if (manifest.action && manifest.action.default_icon && typeof manifest.action.default_icon === "object") {
    for (const [sizeKey, relPath] of Object.entries(manifest.action.default_icon)) {
      iconEntries.push([`action.default_icon.${sizeKey}`, Number(sizeKey), relPath]);
    }
  }

  for (const [label, expectedSize, relPath] of iconEntries) {
    if (typeof relPath !== "string" || relPath.trim() === "") {
      errors.push(`Invalid icon path for ${label}`);
      continue;
    }
    const resolved = path.resolve(EXT_DIR, relPath);
    if (!resolved.startsWith(EXT_DIR + path.sep)) {
      errors.push(`Icon path escapes extension directory for ${label}: ${relPath}`);
      continue;
    }
    validatePngIcon(resolved, expectedSize, label, errors);
  }

  // Scan all JS files under bitbucket-pr-extension/ for forbidden patterns
  const jsFiles = walkFiles(EXT_DIR, (name) => name.endsWith(".js"));
  for (const jsFile of jsFiles) {
    const content = fs.readFileSync(jsFile, "utf8");
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.regex.test(lines[i])) {
          errors.push(
            `Forbidden pattern "${pattern.label}" found in ${path.relative(ROOT_DIR, jsFile)}:${i + 1}`
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error("Extension verification failed:");
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log(
    `Verified manifest (MV${manifest.manifest_version}, v${manifest.version}), ${iconEntries.length} icon declarations, and ${jsFiles.length} JS files.`
  );
}

main();
