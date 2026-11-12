#!/usr/bin/env node
/**
 * Frame the FIRST App Store screenshot: brand background, the app's dog, a
 * headline, and the real captured screen underneath.
 *
 * WHY ONLY THE FIRST. Image #1 is what Messages shows when someone shares the
 * App Store link (the big image on the card; the icon, name and subtitle sit in
 * the footer under it) and what App Store search results show first. It has to
 * read as Feral Travels at a glance. Images 2–4 stay raw captures.
 *
 * WHY NOT THE SPLASH ON ITS OWN. Guideline 2.3.3: screenshots "should show the
 * app in use, and not merely the title art, login page, or splash screen". Text
 * and image overlays ARE allowed, so the dog and the headline frame a real
 * screen rather than replacing it.
 *
 * The raw capture is kept at `<dir>/raw/<name>.png` so the frame can be redone
 * (headline change, art change) without booting a simulator. Re-running is
 * idempotent: it always frames from raw/, never from an already-framed image.
 *
 * Usage:
 *   node scripts/frame-store-screenshots.mjs mobile/screenshots/6.9
 *
 * Called by `scripts/ios-e2e-local.sh screenshots` after the set is measured.
 */

import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERO = '01-map.png';
// Not "cheap fuel": the app finds stations in range, it does not compare prices
// (tabled 2026-11-02 as too hard to do worldwide). Never market prices.
const HEADLINE = ['Adaptive', 'route planning'];
// Sampled from the corners of mobile/assets/splash-icon.png, so the photo's own
// background runs straight into the frame's with no visible edge.
const BG_EDGE = '#553471';
const BG_CENTRE = '#5f3b7b';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(process.argv[2] ?? join(repo, 'mobile/screenshots/6.9'));
const art = join(repo, 'mobile/assets/splash-icon.png');

const dest = join(dir, HERO);
const raw = join(dir, 'raw', HERO);
if (!existsSync(raw)) {
  if (!existsSync(dest)) {
    console.error(`[frame] no ${HERO} in ${dir} — did screenshots.yaml name the map shot ${HERO}?`);
    process.exit(1);
  }
  mkdirSync(dirname(raw), { recursive: true });
  copyFileSync(dest, raw);
}

// The frame is the same size as the capture: one App Store slot, one size.
const pngSize = (file) => {
  const b = readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};
const { w, h } = pngSize(raw);
const dataUrl = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;

// Proportions are of the canvas width, so a 6.5" set frames the same way.
const u = w / 1320;
const shotW = Math.round(940 * u);
const shotTop = Math.round(1010 * u);

const html = `<!doctype html><html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${w}px; height: ${h}px; overflow: hidden; }
  body {
    background: radial-gradient(ellipse at 50% 18%, ${BG_CENTRE} 0%, ${BG_EDGE} 60%);
    font-family: -apple-system, 'SF Pro Display', system-ui, 'Helvetica Neue', Arial, sans-serif;
    position: relative;
  }
  .dog {
    position: absolute; left: 50%; top: ${Math.round(-40 * u)}px;
    width: ${Math.round(720 * u)}px; height: ${Math.round(720 * u)}px;
    transform: translateX(-50%);
    background: url(${dataUrl(art)}) center / cover no-repeat;
    /* fade the square photo into the background so it has no edges */
    -webkit-mask-image: radial-gradient(circle at 50% 46%, #000 52%, transparent 70%);
            mask-image: radial-gradient(circle at 50% 46%, #000 52%, transparent 70%);
  }
  h1 {
    position: absolute; left: 0; right: 0; top: ${Math.round(660 * u)}px;
    text-align: center; color: #fff; font-weight: 800;
    font-size: ${Math.round(112 * u)}px; line-height: 1.08; letter-spacing: -0.02em;
  }
  h1 span { display: block; }
  h1 span + span { color: #f5c451; }
  .shot {
    position: absolute; left: 50%; top: ${shotTop}px; transform: translateX(-50%);
    width: ${shotW}px; border-radius: ${Math.round(72 * u)}px; overflow: hidden;
    border: ${Math.round(14 * u)}px solid #1b1024;
    box-shadow: 0 ${Math.round(40 * u)}px ${Math.round(90 * u)}px rgba(0,0,0,.45);
  }
  .shot img { display: block; width: 100%; }
</style></head><body>
  <div class="dog"></div>
  <h1>${HEADLINE.map((l) => `<span>${l}</span>`).join('')}</h1>
  <div class="shot"><img src="${dataUrl(raw)}"></div>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: dest, type: 'png', omitBackground: false });
} finally {
  await browser.close();
}

// Measured, like every other image in the set — a framed hero that came out a
// different size from 2–4 is a rejected upload.
const out = pngSize(dest);
if (out.w !== w || out.h !== h) {
  console.error(`[frame] ${HERO} came out ${out.w}x${out.h}, expected ${w}x${h}`);
  process.exit(1);
}
console.log(`[frame] ${dest} (${w}x${h}) from ${raw}`);
