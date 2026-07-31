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
      setError("Enter a valid email address.");
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
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Text style={styles.title}>Sign in</Text>

      {step === "email" ? (
        <>
          <Text style={styles.hint}>
            Enter your email and we&apos;ll send you a 6-digit sign-in code.
          </Text>
          <TextInput
            style={styles.input}
            placeholder="you@example.com"
            placeholderTextColor="#6b6459"
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
              <ActivityIndicator color="#1a1a1a" />
            ) : (
              <Text style={styles.buttonText}>Send code</Text>
            )}
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.hint}>
            We sent a code to {email.trim().toLowerCase()}. It expires in 10 minutes.
          </Text>
          <TextInput
            style={[styles.input, styles.codeInput]}
            placeholder="000000"
            placeholderTextColor="#6b6459"
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
              <ActivityIndicator color="#1a1a1a" />
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

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    justifyContent: "center",
    backgroundColor: "#1a1a1a",
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#f5f0e8",
    marginBottom: 8,
  },
  hint: {
    fontSize: 15,
    color: "#b8b0a4",
    marginBottom: 24,
  },
  input: {
    backgroundColor: "#2a2a2a",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: "#f5f0e8",
    marginBottom: 16,
  },
  codeInput: {
    fontSize: 24,
    letterSpacing: 8,
    textAlign: "center",
  },
  button: {
    backgroundColor: "#d4a24e",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1a1a1a",
  },
  link: {
    color: "#d4a24e",
    fontSize: 14,
    textAlign: "center",
    marginTop: 20,
  },
  error: {
    color: "#e0705a",
    fontSize: 14,
    textAlign: "center",
    marginTop: 16,
  },
});
