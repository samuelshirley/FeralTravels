#!/usr/bin/env node
/**
 * Choose the simulator the iOS e2e job should boot, and say so on stdout as
 * `<udid> <human label>`.
 *
 * WHY THIS IS NOT A NAME IN ci.yml. Two constants could live there instead —
 * a device model ("iPhone 17 Pro") and a runtime ("iOS 26.2") — and both are
 * the kind that break silently the month GitHub rolls the runner image
 * forward: the workflow keeps asking for a device that no longer exists and
 * the job dies somewhere unrelated.
 *
 * WHY THE NEWEST RUNTIME, specifically. Maestro ships a PREBUILT XCTest
 * driver, currently built with Xcode 26.2. The macos-15 image carries iOS
 * 18.5, 18.6, 26.0, 26.1 and 26.2 simulators, and `simctl` lists them in no
 * order this script should trust — the version of ci.yml before this file took
 * the first iPhone it saw, which was an iOS 18.5 one, and handed a 26.2 driver
 * a runtime seven versions below it. Taking the newest keeps the driver and
 * the runtime on the same side of that line without naming either.
 *
 * Exits non-zero, loudly, if the image has no available iPhone simulator at
 * all — a job that silently picked "none" would fail much later and much less
 * clearly.
 */
import { execFileSync } from 'node:child_process';

const raw = execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});

/** `com.apple.CoreSimulator.SimRuntime.iOS-26-2` -> [26, 2]; null for tvOS etc. */
function iosVersion(runtimeId) {
  const tail = runtimeId.split('.').pop() ?? '';
  if (!tail.startsWith('iOS-')) return null;
  const parts = tail.slice(4).split('-').map(Number);
  return parts.every(Number.isFinite) ? parts : null;
}

/** Lexicographic on the version tuple: [26, 2] beats [26, 1] beats [18, 6]. */
function isNewer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

let best = null;
for (const [runtimeId, devices] of Object.entries(JSON.parse(raw).devices)) {
  const version = iosVersion(runtimeId);
  if (!version) continue;
  const iphone = devices.find((d) => d.isAvailable && d.name.startsWith('iPhone'));
  if (!iphone) continue;
  if (!best || isNewer(version, best.version)) {
    best = { version, udid: iphone.udid, label: `${iphone.name} on ${runtimeId.split('.').pop()}` };
  }
}

if (!best) {
  console.error('No available iPhone simulator on this runner image. `xcrun simctl list devices available` said:');
  console.error(raw.slice(0, 4000));
  process.exit(1);
}

process.stdout.write(`${best.udid} ${best.label}\n`);
