import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The app never asks iOS for Photos or camera access.
 *
 * ChatPanel's attach button called `requestMediaLibraryPermissionsAsync()`
 * before `launchImageLibraryAsync()`. With `allowsEditing` off, the installed
 * expo-image-picker opens PHPickerViewController (ImagePickerModule.swift,
 * `launchMultiSelectPicker`), which is out of process and needs no permission —
 * so the call raised a full Photos-library prompt for access the app never uses
 * (Guideline 5.1.1), and a "Don't Allow" there blocked a picker that works
 * without it.
 *
 * The camera calls are here too: app.config.js turns NSCameraUsageDescription
 * OFF, so a camera call would not merely prompt — iOS terminates an app that
 * touches the camera with no purpose string.
 *
 * Read as TEXT (noMobileImportGuard: CI's unit job has no mobile/node_modules).
 */
const MOBILE = path.resolve(__dirname, '../../mobile');
const SKIP = new Set(['node_modules', 'ios', 'android', '.expo', 'maestro', 'screenshots']);

const FORBIDDEN = [
  'requestMediaLibraryPermissionsAsync',
  'getMediaLibraryPermissionsAsync',
  'requestCameraPermissionsAsync',
  'launchCameraAsync',
  'useMediaLibraryPermissions',
  'useCameraPermissions',
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Code only — a comment explaining why the call is gone is not a call. */
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FILES = sources(MOBILE);

describe('no Photos or camera permission request in the app', () => {
  it('scans the app source at all', () => {
    // Canary: an empty walk would pass every assertion below.
    expect(FILES.some((f) => f.endsWith(path.join('components', 'ChatPanel.tsx')))).toBe(true);
  });

  it.each(FORBIDDEN)('nothing in mobile/ calls %s', (name) => {
    const hits = FILES.filter((f) => new RegExp(`\\b${name}\\b`).test(code(f))).map((f) =>
      path.relative(MOBILE, f),
    );
    expect(hits).toEqual([]);
  });

  it('the attach button still opens the system picker', () => {
    // The fix is removing the prompt, not the feature.
    const chat = code(path.join(MOBILE, 'components', 'ChatPanel.tsx'));
    expect(chat).toMatch(/ImagePicker\.launchImageLibraryAsync\(/);
    // allowsEditing would route to the legacy UIImagePickerController path.
    expect(chat).not.toMatch(/allowsEditing:\s*true/);
  });
});
