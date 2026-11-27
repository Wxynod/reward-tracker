// Reward Tracker — app icon generator.
//
//   node scripts/build_icons.mjs            # writes every icon into front/
//   node scripts/build_icons.mjs --preview=<dir>  # also writes 1024 px previews of each variant to <dir>
//
// The icon: two cards fanned out (a Hong Kong wallet and a US wallet), the front card carrying
// a rising bar chart (spending analytics). A gold trend line climbs across the chart, leaves
// the card like a flight path and ends in a reward sparkle.
//
// Everything is drawn here as SVG on a 1024 grid and rasterised with the pre-installed
// Playwright Chromium, so each size is rendered from vectors rather than downscaled.
// Small sizes (≤ 64 px) use a simplified glyph that stays legible in a browser tab.
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// require() resolves globally installed packages (NODE_PATH) too, unlike a bare ESM import
const { chromium } = createRequire(import.meta.url)("playwright");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "front");
const OUT = (f) => join(ROOT, f);

// ---------------------------------------------------------------- palette (matches style.css)
const C = {
  sealTop: "#c4493c", seal: "#a3312a", sealDeep: "#7a211b",
  paper: "#fbf6ec", paperEdge: "#efe5d3",
  bar1: "#ecc3b8", bar2: "#d47b6b", bar3: "#a3312a",
  gold: "#e0ac3e", goldDeep: "#b88a1e", goldHi: "#f7d887",
  ink: "#1f1c18",
};

// 4-point sparkle with concave sides, centred on (0,0), radius r
const sparkle = (r, k = 0.26) => {
  const q = r * k;
  return `M0 ${-r} C${q} ${-q} ${q} ${-q} ${r} 0 C${q} ${q} ${q} ${q} 0 ${r} C${-q} ${q} ${-q} ${q} ${-r} 0 C${-q} ${-q} ${-q} ${-q} 0 ${-r}Z`;
};

// ---------------------------------------------------------------- shared defs
const defs = (id) => `
  <linearGradient id="${id}bg" x1="0.15" y1="0" x2="0.85" y2="1">
    <stop offset="0" stop-color="${C.sealTop}"/>
    <stop offset=".55" stop-color="${C.seal}"/>
    <stop offset="1" stop-color="${C.sealDeep}"/>
  </linearGradient>
  <radialGradient id="${id}glow" cx=".28" cy=".18" r=".75">
    <stop offset="0" stop-color="#fff" stop-opacity=".22"/>
    <stop offset=".6" stop-color="#fff" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="${id}paper" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fffdf7"/>
    <stop offset="1" stop-color="${C.paperEdge}"/>
  </linearGradient>
  <linearGradient id="${id}glass" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fff4e6" stop-opacity=".42"/>
    <stop offset="1" stop-color="#fff4e6" stop-opacity=".14"/>
  </linearGradient>
  <linearGradient id="${id}gold" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${C.goldHi}"/>
    <stop offset=".55" stop-color="${C.gold}"/>
    <stop offset="1" stop-color="${C.goldDeep}"/>
  </linearGradient>
  <filter id="${id}sh" x="-30%" y="-30%" width="160%" height="170%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="18"/>
    <feOffset dy="22"/>
    <feComponentTransfer><feFuncA type="linear" slope=".38"/></feComponentTransfer>
    <feFlood flood-color="#3d0d08"/><feComposite operator="in" in2="SourceAlpha"/>
    <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="${id}sh2" x="-50%" y="-50%" width="200%" height="200%">
    <feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#3d0d08" flood-opacity=".35"/>
  </filter>`;

// ---------------------------------------------------------------- full glyph (1024 grid)
// Fits the maskable safe zone: everything stays inside a circle of r≈400 around the centre.
const W = 560, H = 352, R = 54;            // card, ISO 7810 ratio ≈ 1.59
const FRONT = `translate(530 614) rotate(-6) translate(${-W / 2} ${-H / 2})`;
const BACK = `translate(448 528) rotate(-19) translate(${-W / 2} ${-H / 2})`;
function glyph(id) {
  const base = H - 56, bw = 74;
  const bars = [[62, 70, C.bar1], [170, 116, C.bar2], [278, 168, C.bar2], [386, 224, C.bar3]];
  const barSvg = bars.map(([x, h, c]) => `<rect x="${x}" y="${base - h}" width="${bw}" height="${h}" rx="18" fill="${c}"/>`).join("");
  // flight path in page coords: starts on the back card, arcs over, lands in the sparkle
  const S = [232, 470], E = [792, 344];
  return `
    <g transform="${BACK}">
      <rect width="${W}" height="${H}" rx="${R}" fill="url(#${id}glass)" stroke="#fff" stroke-opacity=".5" stroke-width="5"/>
    </g>
    <g transform="${FRONT}" filter="url(#${id}sh)">
      <rect width="${W}" height="${H}" rx="${R}" fill="url(#${id}paper)"/>
      <rect x="62" y="54" width="86" height="64" rx="16" fill="url(#${id}gold)"/>
      <path d="M62 86h86M105 54v64" stroke="${C.goldDeep}" stroke-opacity=".45" stroke-width="5"/>
      ${barSvg}
    </g>
    <path d="M${S[0]} ${S[1]} C 250 250, 560 150, ${E[0] - 52} ${E[1] - 34}"
          fill="none" stroke="#fff3df" stroke-width="19" stroke-linecap="round" stroke-dasharray="0.1 42" opacity=".95"/>
    <circle cx="${S[0]}" cy="${S[1]}" r="20" fill="none" stroke="#fff3df" stroke-width="10"/>
    <g transform="translate(${E[0]} ${E[1]})" filter="url(#${id}sh2)">
      <path d="${sparkle(104)}" fill="url(#${id}gold)"/>
      <path d="${sparkle(34)}" fill="#fffbea" opacity=".9"/>
    </g>`;
}

// simplified glyph for ≤ 64 px and silhouettes: one card, three bars, sparkle.
// Drawn around (500,560); its bounding box centre is ≈ (575,500), so `fit(k)` re-centres it on the canvas.
const fit = (k) => `translate(512 516) scale(${k}) translate(-575 -500)`;
const SMALL_BARS = [[-250, 20, 120], [-90, -60, 200], [70, -140, 280]];   // x, y, h (w = 118)
function glyphSmall(k) {
  const fills = [C.bar1, C.bar2, C.seal];
  return `
  <g transform="${fit(k)}"><g transform="translate(500 560) rotate(-6)">
    <rect x="-340" y="-220" width="680" height="440" rx="78" fill="${C.paper}"/>
    ${SMALL_BARS.map(([x, y, h], i) => `<rect x="${x}" y="${y}" width="118" height="${h}" rx="28" fill="${fills[i]}"/>`).join("")}
    <g transform="translate(330 -210)"><path d="${sparkle(160, 0.24)}" fill="${C.gold}" stroke="${C.seal}" stroke-width="34" stroke-linejoin="round" paint-order="stroke"/></g>
  </g></g>`;
}

// ---------------------------------------------------------------- variants
const svg = (body, id, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024"${extra}><defs>${defs(id)}</defs>${body}</svg>`;

const bgFull = (id) => `<rect width="1024" height="1024" fill="url(#${id}bg)"/><rect width="1024" height="1024" fill="url(#${id}glow)"/>`;

// full-bleed square: iOS / iPadOS (system applies its own mask), Android maskable
const fullBleed = (scale = 1) => svg(
  `${bgFull("a")}<g transform="translate(512 512) scale(${scale}) translate(-512 -512)">${glyph("a")}</g>`, "a");

// "any" purpose: rounded tile with a margin, matches the macOS / Windows / ChromeOS icon grid (824/1024)
const tile = () => svg(`
  <defs><clipPath id="tclip"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
    <filter id="tsh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity=".28"/></filter></defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="#000" filter="url(#tsh)"/>
  <g clip-path="url(#tclip)">
    <g transform="translate(100 100) scale(${824 / 1024})">${bgFull("t")}${glyph("t")}</g>
  </g>
  <rect x="101.5" y="101.5" width="821" height="821" rx="183.5" fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="3"/>`, "t");

// favicon: rounded square filling the frame, simplified glyph
const favicon = () => svg(`
  <rect width="1024" height="1024" rx="224" fill="url(#fbg)"/>${glyphSmall(0.94)}`, "f");

// single-colour silhouette on transparent: card with the bars and the sparkle's halo cut out.
//   k = 0.72 keeps it inside the 80 % safe circle (Android themed icons are masked like maskable ones);
//   k = 1 fills the frame (notification badge, Safari pinned tab)
const mono = (color = "#fff", k = 0.72) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs><mask id="m" maskUnits="userSpaceOnUse" x="-600" y="-600" width="1400" height="1400"><rect x="-600" y="-600" width="1400" height="1400" fill="#fff"/>
    ${SMALL_BARS.map(([x, y, h]) => `<rect x="${x}" y="${y}" width="118" height="${h}" rx="28" fill="#000"/>`).join("")}
    <g transform="translate(330 -210)"><path d="${sparkle(160, 0.24)}" fill="#000" stroke="#000" stroke-width="68" stroke-linejoin="round"/></g>
  </mask></defs>
  <g fill="${color}" transform="${fit(k)}"><g transform="translate(500 560) rotate(-6)">
    <rect x="-340" y="-220" width="680" height="440" rx="78" mask="url(#m)"/>
    <g transform="translate(330 -210)"><path d="${sparkle(160, 0.24)}"/></g>
  </g></g></svg>`;

// ICO container with PNG payloads (supported by every browser and Windows Vista+)
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(([size, buf], i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size % 256, e); head.writeUInt8(size % 256, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += buf.length;
  });
  return Buffer.concat([head, ...pngs.map(([, b]) => b)]);
}

// ---------------------------------------------------------------- render
async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const render = async (markup, size, file) => {
    await page.setViewportSize({ width: size, height: size });
    const sized = markup.replace('width="1024" height="1024"', `width="${size}" height="${size}"`);
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${sized}</body></html>`);
    const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    if (file) writeFileSync(OUT(file), buf);
    return buf;
  };

  const full = fullBleed(1), mask = fullBleed(0.9);
  await render(full, 180, "apple-touch-icon.png");   // iOS adds the rounded mask itself → must be opaque
  await render(tile(), 192, "icon-192.png");
  await render(tile(), 512, "icon-512.png");
  await render(mask, 192, "icon-maskable-192.png");
  await render(mask, 512, "icon-maskable-512.png");
  await render(mono(), 512, "icon-monochrome-512.png");
  await render(mono("#fff", 1), 96, "badge-96.png");      // Android notification small icon (alpha only)
  const icoPngs = [];
  for (const s of [16, 32, 48]) icoPngs.push([s, await render(favicon(), s)]);
  writeFileSync(OUT("favicon.ico"), ico(icoPngs));
  writeFileSync(OUT("favicon.svg"), favicon().replace(' width="1024" height="1024"', ""));
  writeFileSync(OUT("safari-pinned-tab.svg"), mono("#000", 1).replace(' width="1024" height="1024"', ""));

  const pv = process.argv.find((a) => a.startsWith("--preview="));
  if (pv) {
    const dir = pv.slice(10);
    mkdirSync(dir, { recursive: true });
    for (const [name, m] of [["full", full], ["tile", tile()], ["maskable", mask], ["favicon", favicon()], ["mono", mono("#1f1c18")]])
      writeFileSync(join(dir, `${name}-1024.png`), await render(m, 1024));
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
