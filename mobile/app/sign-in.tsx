import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { requestOtp, verifyOtp, ApiError } from "@/lib/api";
import { setToken } from "@/lib/auth";
import { theme } from "@/lib/theme";

type Step = "email" | "code";

export default function SignIn() {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    const trimmed = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(trimmed)) {
      setError("That doesn't look like a valid email address. Please double-check and try again.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await requestOtp(trimmed);
      setStep("code");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the code. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the 6-digit code from the email.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await verifyOtp(email.trim().toLowerCase(), code.trim());
      await setToken(result.token);
      router.replace("/trips");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not verify the code. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.card}>
        <Text style={styles.eyebrow}>FERAL TRAVELS</Text>

        {step === "email" ? (
          <>
            <Text style={styles.title}>Password-less Sign in / Sign-up</Text>
            <Text style={styles.hint}>
              Enter your email and we&apos;ll send you a 6-digit code. The same email always maps
              to one account.
            </Text>
            <Text style={[styles.hint, styles.hintQuip]}>passwords are dumb</Text>
            <TextInput
              style={styles.input}
              placeholder="you@example.com"
              placeholderTextColor={theme.subtle}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              autoFocus
              value={email}
              onChangeText={setEmail}
              onSubmitEditing={sendCode}
              editable={!busy}
            />
            <Pressable
              style={[styles.button, busy && styles.buttonDisabled]}
              onPress={sendCode}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color={theme.onPrimary} />
              ) : (
                <Text style={styles.buttonText}>Email me a code</Text>
              )}
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.title}>Check your email</Text>
            <Text style={styles.hint}>
              We sent a code to {email.trim().toLowerCase()}. It expires in 10 minutes.
            </Text>
            <TextInput
              style={[styles.input, styles.codeInput]}
              placeholder="000000"
              placeholderTextColor={theme.subtle}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              value={code}
              onChangeText={setCode}
              onSubmitEditing={submitCode}
              editable={!busy}
            />
            <Pressable
              style={[styles.button, busy && styles.buttonDisabled]}
              onPress={submitCode}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color={theme.onPrimary} />
              ) : (
                <Text style={styles.buttonText}>Sign in</Text>
              )}
            </Pressable>
            <Pressable
              onPress={() => {
                setStep("email");
                setCode("");
                setError(null);
              }}
              disabled={busy}
            >
              <Text style={styles.link}>Use a different email</Text>
            </Pressable>
          </>
        )}

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    padding: 16,
    justifyContent: "center",
    backgroundColor: theme.bg,
  },
  card: {
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: theme.radiusMd,
    padding: 28,
    shadowColor: theme.text,
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  eyebrow: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 2,
    color: theme.subtle,
    marginBottom: 6,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: theme.text,
    marginBottom: 8,
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
    color: theme.muted,
    marginBottom: 8,
  },
  hintQuip: {
    marginBottom: 24,
  },
  input: {
    backgroundColor: theme.surfaceMuted,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: theme.text,
    marginBottom: 10,
  },
  codeInput: {
    fontSize: 24,
    letterSpacing: 8,
    textAlign: "center",
  },
  button: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 12,
    alignItems: "center",
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.onPrimary,
  },
  link: {
    color: theme.primary,
    fontSize: 13,
    textAlign: "center",
    marginTop: 18,
  },
  errorBox: {
    marginTop: 16,
    padding: 10,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.dangerMuted,
    borderColor: "rgba(198, 93, 74, 0.35)",
    borderWidth: 1,
  },
  errorText: {
    color: theme.danger,
    fontSize: 12,
    lineHeight: 17,
  },
});
