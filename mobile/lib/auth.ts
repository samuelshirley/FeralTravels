import * as SecureStore from "expo-secure-store";

/**
 * Session token storage. The token is a real server-side session (same
 * `sessions` table as the web cookie); we keep it in the iOS keychain via
 * expo-secure-store and send it as `Authorization: Bearer <token>`.
 */
const TOKEN_KEY = "feraltravels.sessionToken";
/**
 * The address the user signed in with. GET /api/me is deliberately PII-free,
 * so this is the ONLY identity the app can show in the account menu.
 */
const EMAIL_KEY = "feraltravels.email";

type Listener = (token: string | null) => void;
const listeners = new Set<Listener>();

/** Subscribe to sign-in / sign-out so screens can react without polling. */
export function onTokenChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function getToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function setToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  listeners.forEach((fn) => fn(token));
}

export async function clearToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.deleteItemAsync(EMAIL_KEY);
  } catch {
    // Already gone — fine.
  }
  listeners.forEach((fn) => fn(null));
}

export async function getSignedInEmail(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(EMAIL_KEY);
  } catch {
    return null;
  }
}

export async function setSignedInEmail(email: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(EMAIL_KEY, email);
  } catch {
    // Non-fatal: the account menu just shows no address.
  }
}
