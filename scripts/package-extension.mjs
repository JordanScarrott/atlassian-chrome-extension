import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const EXT_DIR = path.join(ROOT_DIR, "bitbucket-pr-extension");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const MANIFEST_PATH = path.join(EXT_DIR, "manifest.json");

function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const version = String(manifest.version || "0.0.0").replace(/[^0-9A-Za-z._-]/g, "");
  const outName = `atlassian-hub-v${version}.zip`;
  const outPath = path.join(DIST_DIR, outName);

  fs.mkdirSync(DIST_DIR, { recursive: true });
  if (fs.existsSync(outPath)) {
    fs.unlinkSync(outPath);
  }

  try {
    execFileSync("zip", ["-r", "-q", outPath, "."], {
      cwd: EXT_DIR,
      stdio: "inherit"
    });
  } catch {
    // Fallback to python3's built-in zipfile module if `zip` binary is unavailable
    const pyScript = [
      "import os, sys, zipfile",
      "src, dst = sys.argv[1], sys.argv[2]",
      "with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zf:",
      "    for root, _, files in os.walk(src):",
      "        for f in sorted(files):",
      "            full = os.path.join(root, f)",
      "            rel = os.path.relpath(full, src)",
      "            zf.write(full, rel)"
    ].join("\n");
    execFileSync("python3", ["-c", pyScript, EXT_DIR, outPath], {
      stdio: "inherit"
    });
  }

  const stat = fs.statSync(outPath);
  console.log(`Packaged ${path.relative(ROOT_DIR, outPath)} (${stat.size} bytes)`);
}

main();
