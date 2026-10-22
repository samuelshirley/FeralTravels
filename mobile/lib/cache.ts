import { File, Paths } from "expo-file-system";
import {
  configureResourceCachePersistence,
  type CachePersistence,
} from "@/shared/lib/resourceCache";

/**
 * Disk backend for the resource cache (shared/lib/resourceCache.ts), so a cold
 * launch opens on the trips and the trip the driver had, not on spinners.
 *
 * In `Paths.cache`, deliberately: it is a copy of server data, so iOS may
 * purge it under storage pressure (the next launch is merely a cold one), and
 * the caches directory is excluded from iCloud and device backups, so trip
 * plans never leave the phone that way.
 *
 * SYNCHRONOUS read (`textSync`). The snapshot has to be in memory before the
 * first screen renders, or the first frame of a cold launch is the very
 * spinner this exists to remove. It is a few hundred KB at most
 * (MAX_CACHE_ENTRIES).
 *
 * `expo-file-system` was already in every shipped binary (a dependency of
 * `expo` itself, autolinked); it is declared in package.json now so Metro can
 * resolve it. Every call here is still guarded: if the native module were
 * missing, the cache falls back to this session's memory and nothing throws.
 */
const FILE_NAME = "resource-cache-v1.json";

function cacheFile(): File {
  return new File(Paths.cache, FILE_NAME);
}

const diskBackend: CachePersistence = {
  load() {
    try {
      const file = cacheFile();
      return file.exists ? file.textSync() : null;
    } catch {
      return null;
    }
  },
  save(snapshot) {
    const file = cacheFile();
    if (!file.exists) file.create({ intermediates: true, overwrite: true });
    file.write(snapshot);
  },
  clear() {
    const file = cacheFile();
    if (file.exists) file.delete();
  },
};

let configured = false;

/** Load the snapshot from disk. Idempotent; called at module scope in app/_layout.tsx. */
export function configureResourceCache(): void {
  if (configured) return;
  configured = true;
  try {
    configureResourceCachePersistence(diskBackend);
  } catch {
    configureResourceCachePersistence(null);
  }
}
