import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import BottomNav from "@/components/BottomNav";
import UnitsToggle from "@/components/UnitsToggle";
import VehicleProfileSection from "@/components/VehicleProfileSection";
import { Card, Eyebrow, Spinner } from "@/components/ui";
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
        <Card style={styles.section}>
          <UnitsToggle />
        </Card>

        <Card style={styles.section}>
          <Text style={styles.sectionCaption}>Signed in as</Text>
          {loading && !me ? (
            <Spinner />
          ) : (
            <>
              <Text style={styles.identityPrimary}>{name || email}</Text>
              {email && name ? <Text style={styles.identitySecondary}>{email}</Text> : null}
            </>
          )}
        </Card>

        <Card style={styles.section}>
          <Text style={styles.sectionTitle}>Vehicle profile</Text>
          {/*
            Kept verbatim from the web so the two clients read identically —
            but the copy is STALE: "daily/weekly drive caps" and the "water
            refill / dump cadence" fields are no longer collected. Fix it on
            both platforms together.
          */}
          <Text style={styles.sectionBlurb}>
            Penny uses these constraints to keep your plan realistic — how far you like to
            drive between fuel stops, your daily/weekly drive caps, and your water refill /
            dump cadence.
          </Text>
          <VehicleProfileSection />
        </Card>
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
  title: { fontSize: 28, fontFamily: font.bold, color: theme.text, marginBottom: 24 },
  section: { padding: 20, marginBottom: 16 },
  sectionCaption: { fontFamily: font.regular, fontSize: 12, color: theme.muted, marginBottom: 4 },
  identityPrimary: { fontSize: 15, fontFamily: font.semibold, color: theme.text },
  identitySecondary: { fontFamily: font.regular, fontSize: 12, color: theme.subtle, marginTop: 4 },
  sectionTitle: { fontSize: 16, fontFamily: font.bold, color: theme.text, marginBottom: 6 },
  sectionBlurb: { fontFamily: font.regular, fontSize: 13, color: theme.muted, lineHeight: 20, marginBottom: 14 },
});
