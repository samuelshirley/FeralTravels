import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui";
import { ArrowRightIcon } from "@/components/icons";
import PlanPreview from "@/components/intro/PlanPreview";
import FuelPreview from "@/components/intro/FuelPreview";
import MapsLinkPreview from "@/components/intro/MapsLinkPreview";
import { useReducedMotion } from "@/components/intro/useReducedMotion";
import { setIntroSeen } from "@/lib/auth";
import { useErrors } from "@/lib/errors";
import { introUnitsForLocale } from "@/shared/lib/introUnits";
import { introStartISO } from "@/shared/lib/introFixture";
import { theme, type as typeScale } from "@/lib/theme";
import { font } from "@/lib/typography";

/**
 * First launch: three "how it works" pages, then sign-in.
 *
 * Reached ONLY from the launch gate's no-token branch, when this install has
 * not left the intro before (shared/lib/launchDestination.ts). No questions,
 * no network: every number on these pages is the real trip in
 * shared/lib/introFixture.ts, and nothing here imports the API client, a map
 * view or a video player (introGuard.test.ts).
 *
 * Two exits on every page, both of which record the intro as seen first:
 *  - the primary button: Next, Next, then Create trip, which goes to sign-in
 *    with `next=new-trip` — after sign-in, a new trip opens on Penny's first
 *    question;
 *  - "I already have an account": plain sign-in, then the trips list.
 * Swiping pages too. Nothing advances on its own.
 *
 * Why it exists and what each page claims: docs/design/first-launch-intro.md.
 */
const PAGES = [
  { key: "plan", headline: "Road trip plan with Penny." },
  { key: "fuel", headline: "Gas stops within your range." },
  { key: "link", headline: "Paste a Google Maps link to add a stop." },
] as const;

export default function IntroScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { notify } = useErrors();
  const reducedMotion = useReducedMotion();
  const scroller = useRef<ScrollView>(null);
  const [page, setPage] = useState(0);
  const leaving = useRef(false);

  // Read once: the intro is a single sitting, and a locale change mid-intro
  // redrawing every distance would be stranger than the stale unit.
  const units = useMemo(() => introUnitsForLocale(Intl.NumberFormat().resolvedOptions().locale), []);
  const startISO = useMemo(() => introStartISO(new Date()), []);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      // The page past the halfway point is the active one, so its animation
      // starts while the swipe is still settling, not after.
      const next = Math.round(e.nativeEvent.contentOffset.x / Math.max(width, 1));
      setPage((prev) => (next === prev ? prev : Math.min(Math.max(next, 0), PAGES.length - 1)));
    },
    [width]
  );

  const leave = useCallback(
    (href: "/sign-in?next=new-trip&from=intro" | "/sign-in?from=intro") => {
      if (leaving.current) return;
      leaving.current = true;
      /*
       * Recorded first, but NOT awaited before navigating. A keychain write can
       * stall: on CI run 41431447677 (location-primer-deny) securityd took
       * 20 s to insert this item — SecItemAdd at 11:22:31.965, "inserted" at
       * 11:22:51.594 — and with an `await` here the tap did nothing for those
       * 20 s. The way on must never wait on the keychain. A failed write only
       * means the intro shows again next launch; it is said, not swallowed.
       */
      setIntroSeen().catch((err: unknown) => {
        notify(
          err instanceof Error && err.message
            ? `Couldn't save that you've seen this: ${err.message}`
            : "Couldn't save that you've seen this."
        );
      });
      router.push(href);
      // Back from sign-in returns here; let the exits work again.
      setTimeout(() => {
        leaving.current = false;
      }, 600);
    },
    [notify, router]
  );

  const last = page === PAGES.length - 1;
  const onPrimary = () => {
    if (last) {
      leave("/sign-in?next=new-trip&from=intro");
      return;
    }
    scroller.current?.scrollTo({ x: (page + 1) * width, animated: !reducedMotion });
    setPage(page + 1);
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top + 12, paddingBottom: Math.max(insets.bottom, 16) }]}>
      <ScrollView
        ref={scroller}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={32}
        style={styles.pager}
        testID="intro-pager"
      >
        {PAGES.map((p, i) => (
          <View key={p.key} style={[styles.page, { width }]}>
            {p.key === "plan" ? (
              <PlanPreview active={page === 0} reducedMotion={reducedMotion} units={units} startISO={startISO} />
            ) : p.key === "fuel" ? (
              <FuelPreview active={page === 1} reducedMotion={reducedMotion} units={units} startISO={startISO} />
            ) : (
              <MapsLinkPreview active={page === 2} reducedMotion={reducedMotion} units={units} startISO={startISO} />
            )}
            <Text
              style={styles.headline}
              testID={`intro-page-${i + 1}`}
              accessibilityRole="header"
              // The page position rides on the headline: the dots below are
              // decorative and hidden from VoiceOver.
              accessibilityLabel={`${p.headline} Page ${i + 1} of ${PAGES.length}.`}
            >
              {p.headline}
            </Text>
          </View>
        ))}
      </ScrollView>

      <PageDots page={page} reducedMotion={reducedMotion} />

      <View style={styles.actions}>
        <Button
          label={last ? "Create trip" : "Next"}
          onPress={onPrimary}
          testID="intro-primary"
          trailing={last ? <ArrowRightIcon color={theme.accent300} size={16} /> : undefined}
          style={styles.primary}
        />
        <Pressable
          onPress={() => leave("/sign-in?from=intro")}
          accessibilityRole="button"
          testID="intro-have-account"
          hitSlop={8}
          style={styles.haveAccount}
        >
          <Text style={styles.haveAccountText}>I already have an account</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * The trips list's accent rule as a page indicator: the active page a 16 × 2
 * accent bar, the others 6 × 2 in border-strong, 240 ms ease-out between
 * (Nocturne's progress-bar timing). Widths are not native-driver properties,
 * so each dot is a fixed 16pt bar scaled on X.
 */
function PageDots({ page, reducedMotion }: { page: number; reducedMotion: boolean }) {
  return (
    <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {PAGES.map((p, i) => (
        <Dot key={p.key} active={i === page} reducedMotion={reducedMotion} />
      ))}
    </View>
  );
}

function Dot({ active, reducedMotion }: { active: boolean; reducedMotion: boolean }) {
  const v = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    if (reducedMotion) {
      v.setValue(active ? 1 : 0);
      return;
    }
    const a = Animated.timing(v, {
      toValue: active ? 1 : 0,
      duration: 240,
      easing: Easing.out(Easing.ease),
      useNativeDriver: true,
    });
    a.start();
    return () => a.stop();
  }, [active, reducedMotion, v]);
  return (
    <View style={styles.dotSlot}>
      <Animated.View
        style={[
          styles.dot,
          { backgroundColor: theme.borderStrong, opacity: v.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) },
          { transform: [{ scaleX: v.interpolate({ inputRange: [0, 1], outputRange: [6 / 16, 1] }) }] },
        ]}
      />
      <Animated.View
        style={[
          styles.dot,
          styles.dotOver,
          { backgroundColor: theme.primary, opacity: v },
          { transform: [{ scaleX: v.interpolate({ inputRange: [0, 1], outputRange: [6 / 16, 1] }) }] },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  pager: { flex: 1 },
  page: { alignItems: "center", justifyContent: "center", paddingHorizontal: 24, gap: 18 },
  headline: {
    fontSize: typeScale.xl,
    fontFamily: font.medium,
    lineHeight: 28,
    color: theme.text,
    textAlign: "center",
  },
  dots: { flexDirection: "row", justifyContent: "center", gap: 6, marginTop: 4, marginBottom: 18 },
  dotSlot: { width: 16, height: 2 },
  dot: { position: "absolute", left: 0, top: 0, width: 16, height: 2, borderRadius: 1 },
  dotOver: {},
  actions: { paddingHorizontal: 24, gap: 6 },
  primary: { height: 46, paddingVertical: 0 },
  haveAccount: { alignSelf: "center", minHeight: 44, justifyContent: "center", paddingHorizontal: 12 },
  haveAccountText: { fontFamily: font.medium, fontSize: 14, color: theme.accent300 },
});
