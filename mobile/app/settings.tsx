import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import BottomNav from "@/components/BottomNav";
import UnitsToggle from "@/components/UnitsToggle";
import VehicleProfileSection from "@/components/VehicleProfileSection";
import LocationSection from "@/components/LocationSection";
import DeleteAccountSection from "@/components/DeleteAccountSection";
import SubscriptionSection from "@/components/SubscriptionSection";
import { Eyebrow, Spinner } from "@/components/ui";
import { getMe, isAuthError, type Me } from "@/lib/api";
import { useSignedInEmail } from "@/lib/identity";
import { theme } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * Native mirror of src/app/settings/page.tsx.
 *
 * Section order matches the web exactly. The web page also renders an
 * admin-only "System overview" block; it is deliberately NOT ported, because
 * the admin guards on the server are cookie-only and deliberately reject
 * bearer tokens, so every one of those calls would 401 from the app.
 */
export default function SettingsScreen() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setMe(await getMe());
    } catch (e) {
      // 401 = the token is dead. The global error surface stays quiet on 401
      // by design, so the redirect has to happen here.
      if (isAuthError(e)) {
        router.replace("/sign-in");
        return;
      }
      // Anything else already surfaced through the global notifier; the rest
      // of the screen (units, vehicles) still works without the identity card.
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  // No name is available on native — /api/me carries no PII.
  const name = null;
  const email = useSignedInEmail();

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Eyebrow>USER</Eyebrow>
        <Text style={styles.title}>Settings</Text>

        {/*
          Display-units toggle lives at the top of Settings because the
          Vehicle profile form below changes its label/placeholder text
          (km vs mi) based on this value. Putting it here means the user
          picks units once and the rest of the page reflects it
          immediately via the units context.
        */}
        <View style={styles.section}>
          <UnitsToggle />
        </View>
        <View style={styles.sectionRule} />

        <View style={styles.section}>
          <Text style={styles.sectionCaption}>Signed in as</Text>
          {loading && !me ? (
            <Spinner />
          ) : (
            <>
              <Text style={styles.identityPrimary}>{name || email}</Text>
              {email && name ? <Text style={styles.identitySecondary}>{email}</Text> : null}
            </>
          )}
        </View>
        <View style={styles.sectionRule} />

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Vehicle profile</Text>
          {/*
            One line, and it earns its place under the copy rule in CLAUDE.md:
            the heading and the field already say "vehicle" and "range", but
            nothing on screen says what the number is FOR.

            It replaces four lines that were also WRONG — they promised
            "daily/weekly drive caps" and a "water refill / dump cadence", both
            deleted long ago (migrations 0014/0015). The old comment here
            admitted the copy was stale and asked for it to be fixed on both
            platforms together, which is what this is. Keep it in step with
            src/app/settings/page.tsx.
          */}
          <Text style={styles.sectionBlurb}>Penny plans fuel stops around this range.</Text>
          <VehicleProfileSection />
        </View>
        <View style={styles.sectionRule} />

        {/*
          Between the vehicle profile and the danger zone: a subscriber looking
          for "restore" or "how do I cancel" scrolls here, and neither belongs
          next to the button that deletes their account. Has no web counterpart
          — both are App Store obligations and both are meaningless in a
          browser.
        */}
        <LocationSection />
        <View style={styles.sectionRule} />

        <SubscriptionSection />

        {/*
          Last thing on the screen, same as the web. Apple 5.1.1(v) requires
          this to be reachable in the app itself, so it is not admin-gated or
          hidden behind a web link.
        */}
        <DeleteAccountSection />
      </ScrollView>

      {/*
        Unlike the web's fixed nav, this one is a flex sibling, so it never
        overlaps the scroll view — contentContainer bottom padding is only
        breathing room under the last card. BottomNav adds its own
        safe-area inset for the home indicator.
      */}
      <BottomNav active="settings" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 16, paddingTop: 24, paddingBottom: 80 },
  title: { fontSize: 26, fontFamily: font.medium, color: theme.text, marginBottom: 8 },
  section: { paddingVertical: 20 },
  sectionRule: { height: 1, backgroundColor: theme.neutral900 },
  sectionCaption: { fontFamily: font.regular, fontSize: 11, color: theme.subtle, marginBottom: 4 },
  identityPrimary: { fontSize: 13, fontFamily: font.medium, color: theme.text },
  identitySecondary: { fontFamily: font.regular, fontSize: 13, color: theme.muted, marginTop: 4 },
  sectionTitle: { fontSize: 17, fontFamily: font.medium, color: theme.text, marginBottom: 6 },
  sectionBlurb: { fontFamily: font.regular, fontSize: 13, color: theme.muted, lineHeight: 20, marginBottom: 14 },
});
