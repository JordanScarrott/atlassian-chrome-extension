import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const ICONS_DIR = path.join(ROOT_DIR, "bitbucket-pr-extension", "icons");
const SIZES = [16, 32, 48, 128];

// Atlassian Blue (#0052CC) -> subtle gradient down to #0747A6 for depth
const BG_TOP = [0x00, 0x52, 0xcc];
const BG_BOTTOM = [0x07, 0x47, 0xa6];
const FG_WHITE = [0xff, 0xff, 0xff];

/** Precompute CRC32 table for PNG chunks. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Compute CRC32 checksum of a buffer.
 * @param {Buffer} buf
 * @returns {number}
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Create a PNG chunk buffer.
 * @param {string} type
 * @param {Buffer} data
 * @returns {Buffer}
 */
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Encode RGBA pixel data into a PNG file buffer.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba
 * @returns {Buffer}
 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter type 0 (None)
    const srcStart = y * width * 4;
    raw.set(rgba.subarray(srcStart, srcStart + width * 4), rowStart + 1);
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

/**
 * Signed distance to a rounded rectangle centered at (cx, cy).
 * @param {number} x
 * @param {number} y
 * @param {number} cx
 * @param {number} cy
 * @param {number} halfW
 * @param {number} halfH
 * @param {number} radius
 * @returns {number}
 */
function sdRoundedRect(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - radius;
}

/**
 * Distance from point (px, py) to line segment (ax, ay) -> (bx, by).
 * @param {number} px
 * @param {number} py
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @returns {number}
 */
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lenSq = vx * vx + vy * vy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/**
 * Compute normalized PR/branch icon foreground coverage at normalized [0..1] coordinates.
 * Draws a crisp Pull Request symbol:
 * - Left vertical trunk line connecting top-left and bottom-left nodes
 * - Right branch curve merging from top-right arrow/node into bottom-right node
 * @param {number} u
 * @param {number} v
 * @param {number} size
 * @returns {number} Coverage in [0, 1]
 */
function prSymbolCoverage(u, v, size) {
  const aa = 1.25 / size;
  const strokeHalf = size <= 16 ? 0.055 : 0.048;
  const nodeOuter = size <= 16 ? 0.115 : 0.105;
  const nodeInner = size <= 16 ? 0.042 : 0.044;

  const leftX = 0.31;
  const rightX = 0.69;
  const topY = 0.27;
  const botY = 0.73;

  // Trunk segment (left vertical)
  const dTrunk = distToSegment(u, v, leftX, topY, leftX, botY) - strokeHalf;

  // Branch path: from (rightX, botY) up to (rightX, 0.44), then curving toward (leftX + 0.12, topY)
  const dBranchVert = distToSegment(u, v, rightX, botY, rightX, 0.44) - strokeHalf;
  const dBranchDiag = distToSegment(u, v, rightX, 0.44, 0.49, topY) - strokeHalf;

  // Small directional arrowhead at (0.48, topY) pointing left into top-left node
  const dArrowTop = distToSegment(u, v, 0.47, topY, 0.56, topY - 0.085) - (strokeHalf * 0.85);
  const dArrowBot = distToSegment(u, v, 0.47, topY, 0.56, topY + 0.085) - (strokeHalf * 0.85);

  // Three PR nodes (hollow rings for crispness)
  const nodes = [
    [leftX, topY],
    [leftX, botY],
    [rightX, botY]
  ];

  let minRingDist = Infinity;
  let insideHole = false;
  for (const [nx, ny] of nodes) {
    const dist = Math.hypot(u - nx, v - ny);
    const outerDist = dist - nodeOuter;
    const innerDist = nodeInner - dist;
    const ringDist = Math.max(outerDist, innerDist);
    if (ringDist < minRingDist) {
      minRingDist = ringDist;
    }
    if (dist < nodeInner + aa) {
      insideHole = true;
    }
  }

  // Keep strokes out of the hollow node centers so rings look clean
  const strokeDist = Math.min(dTrunk, dBranchVert, dBranchDiag, dArrowTop, dArrowBot);
  let d = minRingDist;
  if (!insideHole) {
    d = Math.min(d, strokeDist);
  }

  return Math.max(0, Math.min(1, 0.5 - d / aa));
}

/**
 * Render an anti-aliased RGBA icon of the given square dimension.
 * @param {number} size
 * @returns {Uint8Array}
 */
function renderIcon(size) {
  const rgba = new Uint8Array(size * size * 4);
  const pad = size <= 16 ? 0.5 : size * 0.04;
  const half = size / 2 - pad;
  const radius = size * 0.22;

  for (let y = 0; y < size; y += 1) {
    const tGrad = y / Math.max(1, size - 1);
    const bgR = BG_TOP[0] * (1 - tGrad) + BG_BOTTOM[0] * tGrad;
    const bgG = BG_TOP[1] * (1 - tGrad) + BG_BOTTOM[1] * tGrad;
    const bgB = BG_TOP[2] * (1 - tGrad) + BG_BOTTOM[2] * tGrad;

    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;

      const distBadge = sdRoundedRect(px, py, size / 2, size / 2, half, half, radius);
      const badgeAlpha = Math.max(0, Math.min(1, 0.5 - distBadge));

      const u = px / size;
      const v = py / size;
      const fgCov = prSymbolCoverage(u, v, size);

      const r = Math.round(bgR * (1 - fgCov) + FG_WHITE[0] * fgCov);
      const g = Math.round(bgG * (1 - fgCov) + FG_WHITE[1] * fgCov);
      const b = Math.round(bgB * (1 - fgCov) + FG_WHITE[2] * fgCov);
      const a = Math.round(badgeAlpha * 255);

      const idx = (y * size + x) * 4;
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = a;
    }
  }

  return rgba;
}

function main() {
  fs.mkdirSync(ICONS_DIR, { recursive: true });
  for (const size of SIZES) {
    const rgba = renderIcon(size);
    const png = encodePng(size, size, rgba);
    const outPath = path.join(ICONS_DIR, `icon${size}.png`);
    fs.writeFileSync(outPath, png);
    console.log(`Generated ${path.relative(ROOT_DIR, outPath)} (${png.length} bytes)`);
  }
}

main();
