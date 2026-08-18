import { Platform } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import { exchangeOAuth, type SessionResult } from "@/lib/api";
import { GOOGLE_IOS_CLIENT_ID, APPLE_SIGNIN_ENABLED } from "@/lib/config";

/**
 * Native third-party sign-in. Both flows end at the SAME place as the OTP
 * flow — POST /api/mobile/oauth/exchange, which mints a row in the same
 * `sessions` table — so a user who signs in with Google on web and Apple on
 * device still lands on one account, keyed by verified email.
 *
 * Nothing here trusts the provider payload on its own: the ID token goes to
 * the server, which verifies the signature against the provider's JWKS. The
 * client is only a courier.
 */

// Required so the auth browser tab hands control back to the app when it
// redirects. Must run at module scope, before any prompt is opened.
WebBrowser.maybeCompleteAuthSession();

/**
 * Backing out of the system sign-in sheet is a normal thing to do, not a
 * failure. The screen checks for this and re-renders the form untouched
 * instead of accusing the user of an error.
 */
export class OAuthCancelledError extends Error {
  constructor() {
    super("Sign-in cancelled");
    this.name = "OAuthCancelledError";
  }
}

export function isOAuthCancelled(err: unknown): boolean {
  return err instanceof OAuthCancelledError;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * Google needs an iOS OAuth client ID that only exists once Sam creates it in
 * Google Cloud (see build/server/README-oauth.md). Until then the screen hides
 * the button entirely — a visible button that always errors is worse than no
 * button.
 */
export const googleAvailable: boolean = GOOGLE_IOS_CLIENT_ID != null;

/**
 * Sign in with Apple exists on iOS 13+ only; anything else hides the button.
 * isAvailableAsync() reports OS capability, not that WE are configured for it,
 * so the explicit flag has to come first — otherwise the button appears on
 * every simulator and fails on tap.
 */
export async function appleAvailable(): Promise<boolean> {
  if (!APPLE_SIGNIN_ENABLED) return false;
  if (Platform.OS !== "ios") return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    // Module not linked in this build (e.g. Expo Go without the entitlement).
    return false;
  }
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

/**
 * Google's endpoints, hard-coded rather than fetched from
 * /.well-known/openid-configuration: one less network round trip in front of
 * the tap, and these three URLs have been stable for years.
 */
const GOOGLE_DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  revocationEndpoint: "https://oauth2.googleapis.com/revoke",
};

/**
 * Google iOS clients redirect to the client ID with its dot-separated parts
 * reversed: `123-abc.apps.googleusercontent.com` →
 * `com.googleusercontent.apps.123-abc`. That exact string must also be
 * registered as a CFBundleURLScheme in app.json or the browser has nowhere to
 * hand the result back to.
 */
function reversedClientId(clientId: string): string {
  return clientId.split(".").reverse().join(".");
}

export async function signInWithGoogle(): Promise<SessionResult> {
  const clientId = GOOGLE_IOS_CLIENT_ID;
  if (!clientId) {
    throw new Error("Google sign-in isn't configured in this build.");
  }

  const redirectUri = AuthSession.makeRedirectUri({
    native: `${reversedClientId(clientId)}:/oauthredirect`,
  });

  /**
   * Authorization code + PKCE, not the implicit `id_token` response: Google
   * does not issue `response_type=id_token` to installed-app clients, and a
   * public iOS client has no secret to protect the code with, so PKCE is the
   * only thing binding the code to this app. `usePKCE` defaults to true; it's
   * spelled out because turning it off silently would be a security downgrade.
   */
  const request = new AuthSession.AuthRequest({
    clientId,
    redirectUri,
    responseType: AuthSession.ResponseType.Code,
    scopes: ["openid", "profile", "email"],
    usePKCE: true,
  });

  const result = await request.promptAsync(GOOGLE_DISCOVERY);

  if (result.type === "cancel" || result.type === "dismiss") {
    throw new OAuthCancelledError();
  }
  if (result.type !== "success") {
    // 'locked' = another auth session is already open; 'opened' is web-only.
    throw new Error("Couldn't open Google sign-in. Please try again.");
  }
  // Google reports a consent-screen back-out as an error param rather than a
  // browser dismissal, so it has to be unwrapped here too.
  if (result.params.error === "access_denied") {
    throw new OAuthCancelledError();
  }
  if (!result.params.code) {
    throw new Error("Google sign-in didn't return an authorization code.");
  }

  const tokens = await AuthSession.exchangeCodeAsync(
    {
      clientId,
      code: result.params.code,
      redirectUri,
      // Proves this app started the flow — the server side of PKCE.
      extraParams: request.codeVerifier
        ? { code_verifier: request.codeVerifier }
        : undefined,
    },
    GOOGLE_DISCOVERY
  );

  const idToken = tokens.idToken;
  if (!idToken) {
    // Almost always a missing `openid` scope on the client registration.
    throw new Error("Google didn't return an ID token. Please try again.");
  }

  return exchangeOAuth({ provider: "google", idToken });
}

// ---------------------------------------------------------------------------
// Apple
// ---------------------------------------------------------------------------

export async function signInWithApple(): Promise<SessionResult> {
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (
      code === "ERR_REQUEST_CANCELED" ||
      code === "ERR_CANCELED" ||
      /cancell?ed/i.test(message)
    ) {
      throw new OAuthCancelledError();
    }
    throw new Error("Apple sign-in failed. Please try again or use your email.");
  }

  const idToken = credential.identityToken;
  if (!idToken) {
    throw new Error("Apple didn't return an identity token. Please try again.");
  }

  /**
   * Apple returns the user's name ONLY on the very first authorization for
   * this app — every later sign-in has `fullName: null`, and the identity
   * token never carries a name claim. So it is forwarded now or lost forever;
   * the server stores it on create and ignores it afterwards.
   */
  const parts = [credential.fullName?.givenName, credential.fullName?.familyName];
  const fullName = parts.filter(Boolean).join(" ").trim() || null;

  return exchangeOAuth({ provider: "apple", idToken, fullName });
}
