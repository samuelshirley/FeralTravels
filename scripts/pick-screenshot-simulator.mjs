#!/usr/bin/env node
/**
 * Choose the simulator for one App Store screenshot size, and say what pixel
 * dimensions it must produce.
 *
 * THIS PINS DEVICE MODELS, and `scripts/pick-ios-simulator.mjs` deliberately
 * does not. That is not an inconsistency, it is the difference between the two
 * jobs. A test flow wants any iPhone that boots — naming one is how the job
 * breaks silently the month the runner image drops it. A SCREENSHOT is defined
 * by its pixel dimensions: App Store Connect rejects an upload whose image is
 * not one of the sizes it expects for the slot, so the model is not an
 * incidental detail here, it IS the requirement.
 *
 * The mitigation for pinning is that each size holds a LIST, newest first, and
 * the first model actually installed wins. A dropped model costs a line, not a
 * broken command, and an empty list produces an error naming the `simctl`
 * invocation that creates one rather than a stack trace.
 *
 * Usage:
 *   node scripts/pick-screenshot-simulator.mjs 6.9
 *   node scripts/pick-screenshot-simulator.mjs --list
 *
 * Prints one line: `<udid> <width> <height> <model>`  (tab-separated)
 */

import { execFileSync } from 'node:child_process';

/**
 * App Store screenshot slots this app can fill, and the devices that fill them.
 *
 * ONLY 6.9-INCH IS REQUIRED. `app.config.js` sets `supportsTablet: false`, so
 * there is no iPad slot to fill at all, and Apple scales the 6.9" set down for
 * every smaller iPhone — which is why §3 of docs/design/app-store-listing.md
 * says three to five images and stops. 6.5" is here because Apple still accepts
 * it as the alternative iPhone slot and it costs one array to keep the option.
 *
 * BOTH dimensions are listed per slot because Apple accepts two for 6.9":
 * 1290x2796 (iPhone 14/15/16 Plus and Pro Max lineage) and 1320x2868 (16/17 Pro
 * Max). A run must produce one of them, consistently, for every shot in the
 * set — a mixed set is a rejected upload.
 *
 * NOTE, and this is a correction: §3 of the listing doc says to capture
 * "1290 x 2796 from the iPhone 17 Pro simulator". Those two do not go together.
 * The iPhone 17 Pro is the 6.3" device at 1206x2622; the 6.9" slot needs a
 * Pro Max or a Plus. That instruction would have produced a set App Store
 * Connect refuses.
 */
const SIZES = {
  '6.9': {
    label: '6.9-inch iPhone (required)',
    // Newest first. The first one present on the machine wins.
    models: [
      'iPhone 17 Pro Max',
      'iPhone 16 Pro Max',
      'iPhone 15 Pro Max',
      'iPhone 16 Plus',
      'iPhone 15 Plus',
    ],
    accepted: [
      [1320, 2868],
      [1290, 2796],
    ],
  },
  '6.5': {
    label: '6.5-inch iPhone (optional alternative)',
    models: ['iPhone 14 Plus', 'iPhone 11 Pro Max', 'iPhone XS Max'],
    accepted: [[1242, 2688]],
  },
};

function devices() {
  const raw = execFileSync('xcrun', ['simctl', 'list', 'devices', '--json'], {
    encoding: 'utf8',
  });
  const byRuntime = JSON.parse(raw).devices ?? {};
  const out = [];
  for (const [runtime, list] of Object.entries(byRuntime)) {
    // `com.apple.CoreSimulator.SimRuntime.iOS-26-5` -> [26, 5]
    const m = /SimRuntime\.iOS-(\d+)(?:-(\d+))?/.exec(runtime);
    if (!m) continue;
    const version = [Number(m[1]), Number(m[2] ?? 0)];
    for (const d of list) {
      // `isAvailable` false means the runtime was removed from under it. Such a
      // device is listed, cannot boot, and produces a `simctl` error several
      // minutes later that says nothing about why.
      if (!d.isAvailable) continue;
      out.push({ udid: d.udid, name: d.name, version });
    }
  }
  return out;
}

function pick(sizeKey) {
  const size = SIZES[sizeKey];
  if (!size) {
    throw new Error(
      `unknown size "${sizeKey}". Known: ${Object.keys(SIZES).join(', ')}`
    );
  }

  const available = devices();
  for (const model of size.models) {
    // Exact name match. `startsWith` would let "iPhone 16 Pro" satisfy a
    // request for "iPhone 16 Pro Max"'s neighbour on some naming schemes, and
    // that is a whole different screen size.
    const matches = available.filter((d) => d.name === model);
    if (!matches.length) continue;
    // Newest runtime among the copies of that model. Someone with an old and a
    // new runtime installed has two devices of the same name.
    matches.sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1]);
    const chosen = matches[0];
    // The FIRST accepted pair is the canonical one for the model list's head;
    // the shell verifies the PNG against every accepted pair, so this is only a
    // hint for the log.
    const [w, h] = size.accepted[0];
    return { udid: chosen.udid, model, width: w, height: h, accepted: size.accepted };
  }

  throw new Error(
    `no simulator installed for the ${size.label}.\n` +
      `  Tried, newest first: ${size.models.join(', ')}\n` +
      `  Create one with:\n` +
      `    xcrun simctl create "${size.models[0]}" "${size.models[0]}"\n` +
      `  (Xcode > Settings > Components must have an iOS runtime installed first.)`
  );
}

const arg = process.argv[2];

if (arg === '--list' || !arg) {
  for (const [key, size] of Object.entries(SIZES)) {
    process.stdout.write(
      `${key}\t${size.label}\t${size.accepted.map((p) => p.join('x')).join(' or ')}\n`
    );
  }
  process.exit(0);
}

try {
  const p = pick(arg);
  process.stdout.write(`${p.udid}\t${p.width}\t${p.height}\t${p.model}\n`);
} catch (err) {
  process.stderr.write(`[screenshots] ${err.message}\n`);
  process.exit(1);
}
