import * as SecureStore from "expo-secure-store";

/**
 * Session token storage. The token is a real server-side session (same
 * `sessions` table as the web cookie); we keep it in the iOS keychain via
 * expo-secure-store and send it as `Authorization: Bearer <token>`.
 */
const TOKEN_KEY = "feraltravels.sessionToken";

export async function getToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function setToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // Already gone — fine.
  }
}
