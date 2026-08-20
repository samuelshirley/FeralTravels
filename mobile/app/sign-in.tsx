import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { useRouter } from "expo-router";
import * as AppleAuthentication from "expo-apple-authentication";
import { Banner, Button, Card, Eyebrow } from "@/components/ui";
import { theme } from "@/lib/theme";
import { ApiError, requestOtp, verifyOtp, type SessionResult } from "@/lib/api";
import { setToken, setSignedInEmail } from "@/lib/auth";
import { font } from "@/lib/typography";
import {
  appleAvailable,
  googleAvailable,
  isOAuthCancelled,
  signInWithApple,
  signInWithGoogle,
} from "@/lib/oauth";

/**
 * Native port of the web sign-in page (src/app/login/page.tsx). Same two
 * steps, same copy, same error strings — a user who has signed in on web
 * should recognise every word here.
 */

const CODE_LENGTH = 6;

// ---------------------------------------------------------------------------
// Client-side email checks — mirrors the web's pre-flight validation.
// Both exist to avoid burning a send (and a 60s rate-limit window) on an
// address that can never receive the mail.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

/** Fat-finger domains, mapped to what the user almost certainly meant. */
const DOMAIN_TYPOS: Record<string, string> = {
  "gmail.con": "gmail.com",
  "gmail.cmo": "gmail.com",
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gmal.com": "gmail.com",
  "gamil.com": "gmail.com",
  "hotmal.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "hotmail.con": "hotmail.com",
  "outloo.com": "outlook.com",
  "outlok.com": "outlook.com",
  "outlook.con": "outlook.com",
  "yahooo.com": "yahoo.com",
  "yaho.com": "yahoo.com",
  "yahoo.con": "yahoo.com",
  "icloud.con": "icloud.com",
  "iclod.com": "icloud.com",
};

/** Returns the error copy to show, or null when the address looks sendable. */
function validateEmailLocally(email: string): string | null {
  if (!EMAIL_RE.test(email)) return ERROR_COPY.InvalidEmail;
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const suggested = DOMAIN_TYPOS[domain];
  if (suggested) return typoSuggestionCopy(suggested);
  return null;
}

// ---------------------------------------------------------------------------
// Error copy — verbatim from the web login page, keyed by the server's code.
// ---------------------------------------------------------------------------

const ERROR_COPY: Record<string, string> = {
  OAuthAccountNotLinked:
    "This email is already tied to a different sign-in method. Use the Google button above if you usually sign in with Google, or enter your email again to get a new code.",
  InvalidEmail:
    "That doesn't look like a valid email address. Please double-check and try again.",
  EmailSendFailed:
    "Couldn't send your sign-in code. Try Google sign-in or contact support.",
  Configuration:
    "Couldn't send your sign-in code. Try Google sign-in or contact support.",
  AccessDenied: "Access denied. If you think this is a mistake, contact support.",
  RateLimited:
    "A code was already sent recently — please wait 60 seconds before requesting another.",
  InvalidCode:
    "That code is incorrect or has expired. Please try again or request a new one.",
  // --- native OAuth exchange (/api/mobile/oauth/exchange) ---
  InvalidToken:
    "That sign-in didn't check out. Please try again, or use your email to get a code.",
  EmailNotVerified:
    "That account's email address isn't verified with its provider, so we can't sign you in with it. Use your email to get a code instead.",
  ProviderNotConfigured:
    "That sign-in option isn't available yet. Please use your email to get a code.",
  InvalidRequest: "Something went wrong signing you in. Please try again.",
};

const GENERIC_ERROR = "Something went wrong. Please try again.";

function typoSuggestionCopy(suggested: string): string {
  return `Did you mean @${suggested}? Please check your email and try again.`;
}

/**
 * The API returns `{ error: '<Code>' }`; ApiError surfaces that as `.message`
 * and keeps the parsed body on `.payload`. Map the code to the web's wording,
 * and never leak a raw code (or "HTTP 500") into the banner.
 */
function messageFor(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return err instanceof Error && err.message ? err.message : GENERIC_ERROR;
  }
  const payload =
    err.payload && typeof err.payload === "object"
      ? (err.payload as Record<string, unknown>)
      : null;
  const code = typeof payload?.error === "string" ? payload.error : err.message;

  if (code === "TypoSuggestion") {
    const suggested = typeof payload?.suggested === "string" ? payload.suggested : "";
    return typoSuggestionCopy(suggested);
  }
  const known = ERROR_COPY[code];
  if (known) return known;
  // A message with spaces is prose the server meant for humans; a bare token
  // is an unmapped code and would read as gibberish.
  return code.includes(" ") ? code : GENERIC_ERROR;
}

/** first char + "***@" + domain; left alone when the local part is tiny. */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 0) return email;
  const local = email.slice(0, at);
  if (local.length <= 2) return email;
  return `${local[0]}***@${email.slice(at + 1)}`;
}

const ALREADY_SENT_NOTICE = "We already sent you a code — enter it below.";

// ---------------------------------------------------------------------------

export default function SignInScreen() {
  const router = useRouter();

  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState<string[]>(() => Array(CODE_LENGTH).fill(""));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [oauthBusy, setOauthBusy] = useState<"google" | "apple" | null>(null);
  const [showApple, setShowApple] = useState(false);

  const boxes = useRef<Array<TextInput | null>>([]);
  // Read inside the auto-submit effect, which must not depend on `verifying`
  // (re-running it on every state flip would double-submit the same code).
  const verifyingRef = useRef(false);

  useEffect(() => {
    let alive = true;
    void appleAvailable().then((ok) => {
      if (alive) setShowApple(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  const finish = useCallback(
    async (result: SessionResult) => {
      await setToken(result.token);
      // Only identity the app has — /api/me returns no PII.
      if (result.user?.email) await setSignedInEmail(result.user.email);
      router.replace("/trips");
    },
    [router]
  );

  const goToCodeStep = useCallback((withNotice: string | null) => {
    setStep("code");
    setCode(Array(CODE_LENGTH).fill(""));
    setError(null);
    setNotice(withNotice);
    // Give the step swap a frame to mount before grabbing focus.
    setTimeout(() => boxes.current[0]?.focus(), 50);
  }, []);

  // -- step 1: send ---------------------------------------------------------

  const send = useCallback(async () => {
    const trimmed = email.trim();
    const localProblem = validateEmailLocally(trimmed);
    if (localProblem) {
      setError(localProblem);
      return;
    }
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      await requestOtp(trimmed);
      goToCodeStep(null);
    } catch (err) {
      /**
       * 429 means a code went out less than 60s ago — and that code is STILL
       * VALID and already sitting in the user's inbox. Showing "wait 60
       * seconds" on the email step strands them in front of a form they have
       * no reason to use. Move them forward and say so.
       */
      if (err instanceof ApiError && err.status === 429) {
        goToCodeStep(ALREADY_SENT_NOTICE);
        return;
      }
      setError(messageFor(err));
    } finally {
      setSending(false);
    }
  }, [email, goToCodeStep]);

  // -- step 2: verify -------------------------------------------------------

  const submitCode = useCallback(
    async (value: string) => {
      if (verifyingRef.current) return;
      verifyingRef.current = true;
      setVerifying(true);
      setError(null);
      setNotice(null);
      try {
        const result = await verifyOtp(email.trim(), value);
        await finish(result);
      } catch (err) {
        setError(messageFor(err));
        // Clear the boxes so the auto-submit effect can fire again on the
        // next full entry (and so the user isn't editing a dead code).
        setCode(Array(CODE_LENGTH).fill(""));
        boxes.current[0]?.focus();
      } finally {
        verifyingRef.current = false;
        setVerifying(false);
      }
    },
    [email, finish]
  );

  const joined = code.join("");
  const complete = joined.length === CODE_LENGTH;

  // Auto-submit the moment all six digits are present — including from an
  // SMS/email autofill tap, where the user never touches the button.
  useEffect(() => {
    if (joined.length === CODE_LENGTH) void submitCode(joined);
  }, [joined, submitCode]);

  const handleChange = useCallback((index: number, text: string) => {
    const digits = text.replace(/[^0-9]/g, "");

    if (digits.length === 0) {
      setCode((prev) => {
        const next = [...prev];
        next[index] = "";
        return next;
      });
      return;
    }

    // A paste or an iOS one-time-code autofill arrives as the whole string in
    // a single box; spread it across the remaining boxes instead of dropping
    // everything but the first character.
    if (digits.length > 1) {
      setCode((prev) => {
        const next = [...prev];
        for (let i = 0; i < digits.length && index + i < CODE_LENGTH; i += 1) {
          next[index + i] = digits[i];
        }
        return next;
      });
      const lastFilled = Math.min(index + digits.length, CODE_LENGTH) - 1;
      if (lastFilled >= CODE_LENGTH - 1) boxes.current[CODE_LENGTH - 1]?.blur();
      else boxes.current[lastFilled + 1]?.focus();
      return;
    }

    setCode((prev) => {
      const next = [...prev];
      next[index] = digits;
      return next;
    });
    if (index < CODE_LENGTH - 1) boxes.current[index + 1]?.focus();
    else boxes.current[index]?.blur();
  }, []);

  const handleKeyPress = useCallback(
    (index: number, e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (e.nativeEvent.key !== "Backspace") return;
      // Backspace on an already-empty box clears the previous one and steps
      // back, so a run of backspaces walks the code out right-to-left.
      setCode((prev) => {
        if (prev[index]) return prev;
        if (index === 0) return prev;
        const next = [...prev];
        next[index - 1] = "";
        return next;
      });
      if (!code[index] && index > 0) boxes.current[index - 1]?.focus();
    },
    [code]
  );

  const resend = useCallback(async () => {
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      await requestOtp(email.trim());
      setCode(Array(CODE_LENGTH).fill(""));
      setNotice(`A new code was sent to ${maskEmail(email.trim())}.`);
      boxes.current[0]?.focus();
    } catch (err) {
      // Same 429 reasoning as the send step: the previous code still works,
      // so keep the user here rather than bouncing them back a step.
      if (err instanceof ApiError && err.status === 429) {
        setNotice(ALREADY_SENT_NOTICE);
        return;
      }
      setError(messageFor(err));
    } finally {
      setSending(false);
    }
  }, [email]);

  // -- oauth ----------------------------------------------------------------

  const runOAuth = useCallback(
    async (provider: "google" | "apple") => {
      setOauthBusy(provider);
      setError(null);
      setNotice(null);
      try {
        const result =
          provider === "google" ? await signInWithGoogle() : await signInWithApple();
        await finish(result);
      } catch (err) {
        // Backing out of the system sheet is a deliberate choice, not a
        // failure — return to the form silently.
        if (isOAuthCancelled(err)) return;
        setError(messageFor(err));
      } finally {
        setOauthBusy(null);
      }
    },
    [finish]
  );

  // -------------------------------------------------------------------------

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <Card style={styles.card}>
          {step === "email" ? (
            <>
              <Eyebrow>FERAL TRAVELS</Eyebrow>
              <Text style={styles.h1}>Password-less Sign in / Sign-up</Text>
              {/* The web copy opens with "Sign in with Google, or…" because the
                  web ALWAYS has that button. Here it is conditional on an iOS
                  OAuth client id, so the sentence has to follow the button —
                  advertising a provider that is not on screen is worse than
                  plainer copy. */}
              <Text style={styles.body}>
                {googleAvailable
                  ? "Sign in with Google, or enter your email and we'll send you a 6-digit code. The same email always maps to one account."
                  : "Enter your email and we'll send you a 6-digit code. The same email always maps to one account."}
              </Text>
              <Text style={[styles.body, styles.bodyGap]}>passwords are dumb</Text>

              {error ? <Banner tone="danger" body={error} /> : null}

              {/* Guideline 4.8 / Apple HIG: Sign in with Apple must sit at
                  least as prominently as any other third-party option, so it
                  goes above Google. */}
              {showApple ? (
                <AppleAuthentication.AppleAuthenticationButton
                  buttonType={
                    AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN
                  }
                  buttonStyle={
                    AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
                  }
                  cornerRadius={theme.radiusSm}
                  style={styles.appleButton}
                  onPress={() => void runOAuth("apple")}
                />
              ) : null}

              {googleAvailable ? (
                <Pressable
                  onPress={() => void runOAuth("google")}
                  disabled={oauthBusy != null}
                  style={[
                    styles.oauthButton,
                    oauthBusy != null && styles.disabled,
                  ]}
                >
                  <Text style={styles.googleGlyph}>G</Text>
                  <Text style={styles.oauthLabel}>
                    {oauthBusy === "google" ? "Opening Google…" : "Continue with Google"}
                  </Text>
                </Pressable>
              ) : null}

              <View style={styles.divider}>
                <View style={styles.hairline} />
                <Text style={styles.dividerLabel}>OR EMAIL</Text>
                <View style={styles.hairline} />
              </View>

              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                placeholderTextColor={theme.subtle}
                style={styles.input}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="emailAddress"
                returnKeyType="send"
                onSubmitEditing={() => void send()}
                editable={!sending}
              />
              <Button
                label="Email me a code"
                onPress={() => void send()}
                busy={sending}
                style={styles.submit}
              />
            </>
          ) : (
            <>
              <Eyebrow>FERAL TRAVELS</Eyebrow>
              <Text style={styles.h1}>Enter your code</Text>
              <Text style={styles.body}>
                We sent a 6-digit code to {maskEmail(email.trim())}. Enter it below —
                it expires in 10 minutes.
              </Text>

              {error ? <Banner tone="danger" body={error} /> : null}
              {notice ? <Banner tone="info" body={notice} /> : null}

              <View style={styles.codeRow}>
                {code.map((digit, i) => (
                  <TextInput
                    key={i}
                    ref={(el) => {
                      boxes.current[i] = el;
                    }}
                    value={digit}
                    onChangeText={(t) => handleChange(i, t)}
                    onKeyPress={(e) => handleKeyPress(i, e)}
                    style={styles.codeBox}
                    keyboardType="number-pad"
                    // maxLength stays >1 so a pasted / autofilled six-digit
                    // string reaches onChangeText intact and can be spread.
                    maxLength={CODE_LENGTH}
                    selectTextOnFocus
                    // Only the first box carries the autofill hint; iOS drops
                    // the whole code into it and the spread handles the rest.
                    textContentType={i === 0 ? "oneTimeCode" : "none"}
                    autoComplete={i === 0 ? "one-time-code" : "off"}
                    autoFocus={i === 0}
                    editable={!verifying}
                  />
                ))}
              </View>

              <Button
                label={verifying ? "Verifying…" : "Verify code"}
                onPress={() => void submitCode(joined)}
                disabled={!complete || verifying}
                style={styles.submit}
              />

              <View style={styles.footer}>
                <Text style={styles.footerText}>
                  Didn&apos;t get it?{" "}
                  <Text style={styles.link} onPress={() => void resend()}>
                    Resend code
                  </Text>
                </Text>
                <Pressable
                  onPress={() => {
                    setStep("email");
                    setCode(Array(CODE_LENGTH).fill(""));
                    setError(null);
                    setNotice(null);
                  }}
                >
                  <Text style={[styles.footerText, styles.link, styles.footerBack]}>
                    ← Use a different email
                  </Text>
                </Pressable>
              </View>
            </>
          )}
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.bg },
  scroll: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 20,
    backgroundColor: theme.bg,
  },
  card: { width: "100%", maxWidth: 420, alignSelf: "center", padding: 20 },
  h1: {
    // src/app/login/page.tsx:89 — fontSize 24, weight 700, marginBottom 4,
    // and no letter-spacing.
    fontSize: 24,
    fontFamily: font.bold,
    color: theme.text,
    marginBottom: 4,
  },
  // src/app/login/page.tsx:90-98 — fontSize 13, line-height 1.5.
  body: { fontFamily: font.regular, fontSize: 13, lineHeight: 19.5, color: theme.muted },
  bodyGap: { marginTop: 14, marginBottom: 4 },

  oauthButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    // src/app/login/page.tsx:143 — gap: 10
    gap: 10,
    height: 44,
    marginTop: 14,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.borderStrong,
  },
  appleButton: { height: 44, marginTop: 14 },
  googleGlyph: { fontSize: 16, fontFamily: font.extrabold, color: theme.text },
  oauthLabel: { fontSize: 14, fontFamily: font.semibold, color: theme.text },
  disabled: { opacity: 0.6 },

  // src/app/login/page.tsx:152-161 — gap 12, margin '20px 0 16px', the rules
  // are 1px tall, and the label is 11px / 0.1em with no weight override (400).
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 20,
    marginBottom: 16,
  },
  hairline: { flex: 1, height: 1, backgroundColor: theme.border },
  dividerLabel: {
    fontSize: 11,
    letterSpacing: 1.1,
    fontFamily: font.regular,
    color: theme.subtle,
  },

  input: {
    fontFamily: font.regular,
    height: 44,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.surfaceMuted,
    paddingHorizontal: 12,
    fontSize: 15,
    color: theme.text,
  },
  submit: { marginTop: 12 },

  codeRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    marginTop: 18,
  },
  codeBox: {
    flex: 1,
    maxWidth: 52,
    aspectRatio: 1 / 1.2,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.surfaceMuted,
    textAlign: "center",
    fontSize: 22,
    fontFamily: font.bold,
    color: theme.text,
    fontVariant: ["tabular-nums"],
  },

  footer: { marginTop: 16, alignItems: "center", gap: 10 },
  footerText: { fontFamily: font.regular, fontSize: 13, color: theme.muted },
  footerBack: { marginTop: 2 },
  link: { color: theme.primary, fontFamily: font.semibold },
});
