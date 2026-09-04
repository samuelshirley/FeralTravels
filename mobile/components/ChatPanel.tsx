import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Image,
  Keyboard,
  Linking,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Crypto from "expo-crypto";
import * as ImagePicker from "expo-image-picker";
import {
  authHeaders,
  tripApi,
  type OnboardingQuestion,
  type OnboardingSnapshot,
} from "@/lib/api";
import { API_BASE_URL } from "@/lib/config";
import type { OnboardingState } from "@/shared/types/trip";
import { useUnits } from "@/lib/units";
import { useErrors } from "@/lib/errors";
import { onPennyPrefill } from "@/lib/pennyPrefill";
import { theme } from "@/lib/theme";
import {
  fetchEntitlement,
  withPaywallNotice,
  PAYWALL_ERROR_CODE,
  type EntitlementPayload,
} from "@/lib/entitlement";
import { usePurchaseFlow } from "@/lib/purchaseFlow";
import PurchaseSheet from "@/components/PurchaseSheet";
import { PaperclipIcon, SendArrowIcon } from "@/components/icons";
import { Spinner } from "@/components/ui";
import PlanSummaryCard from "@/components/chat/PlanSummaryCard";
import { BlinkingCursor, TypingBubble } from "@/components/chat/Indicators";
import { bubbleRadius, getGroupPosition } from "@/components/chat/format";
import { startTurnStream, type TurnStreamHandle } from "@/components/chat/turnStream";
import { font } from "@/lib/typography";
import {
  deriveApplyOutcome,
  type AppliedEvent,
  type AttachedImage,
  type DeliveryStatus,
  type UIMessage,
} from "@/components/chat/types";

/**
 * Native port of src/components/ChatPanel.tsx.
 *
 * Everything user-visible is a straight port — the iMessage bubble grouping,
 * the delivery receipts, the onboarding Q&A takeover, the deterministic plan
 * card, the crash-heal. The three things that could NOT be ported, and why:
 *
 *  1. Streaming transport. RN's fetch has no `res.body` ReadableStream, so the
 *     web's `reader.read()` loop is impossible. See components/chat/turnStream.ts.
 *  2. Drag-and-drop and clipboard-paste image attach. A phone has neither a
 *     drag source nor a `ClipboardEvent` on a text field — the attach button
 *     (expo-image-picker) is the only attach path, so the web's drop overlay,
 *     `dragDepthRef` bookkeeping and `handlePaste` are deliberately absent.
 *  3. Enter-to-send. On a soft keyboard the return key must stay a newline;
 *     the circular send button is the only send affordance.
 *
 * And one divergence in the PAYWALL, which is otherwise a straight port of the
 * web's (Penny's message in the transcript, purchase sheet as the only modal):
 *
 *  4. The web guards its send path in `sendMessage`, the composer wrapper.
 *     Native guards inside `sendChatMessage` instead, because there is a second
 *     send affordance the composer knows nothing about — the "Continue
 *     planning" button inside a truncated bubble, which calls the engine
 *     directly. A guard on the composer alone would leave that button firing
 *     requests whose only possible answer is a 402.
 */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Canned prompt behind the truncated-plan card's "Continue planning" button. */
const CONTINUE_PROMPT =
  "Continue planning the trip from where you left off. Add the remaining legs.";

/**
 * Caption Penny "sends" alongside the dog-fetch clip on the first full build.
 * The clip itself (PennyPlanningVideo) is not ported — there is no video asset
 * in the native bundle — but the caption still carries the "this will take a
 * moment" expectation, which is the part that matters during a 60s+ build.
 */
const PLANNING_VIDEO_COPY = "Give me a sec — mapping your route and finding fuel…";

/**
 * One inbox, one human — the same address as /support and as the web's
 * `SUPPORT_EMAIL`.
 *
 * Duplicated rather than imported: the web's constant lives in
 * src/lib/paywallCopy.ts, which is NOT in `SHARED_FILES` (scripts/sync-shared.mjs)
 * because the rest of that module is web block-notice copy the app never
 * renders. If the support address ever changes, it changes in both places.
 */
const SUPPORT_EMAIL = "support@feraltravels.com";

/**
 * Penny's paywall copy, as paragraphs.
 *
 * A native <Text> renders "\n\n" as a bare blank line at the bubble's own
 * line-height — which is exactly what a stray newline in a streamed reply looks
 * like. This is the one bubble whose text was written rather than streamed, and
 * the one the user is being asked to read and act on, so it gets real paragraph
 * spacing instead of an accident of whitespace.
 */
function PaywallText({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean);
  return (
    <>
      {paragraphs.map((para, i) => (
        <Text key={i} style={[styles.bubbleText, i === 0 ? null : styles.paywallParagraph]}>
          {para}
        </Text>
      ))}
    </>
  );
}

interface ChatPanelProps {
  tripId: string;
  /** When not 'done', the composer submits onboarding answers until handoff. */
  onboardingState: OnboardingState;
  readonly: boolean;
  onTripUpdated: () => void;
  onActivity: (kind: "thinking" | "response" | "error") => void;
}

/**
 * The three on-trip prompt rows, and the on-trip equivalents of onboarding's
 * first-run ones. Each is a DIFFERENT shape of request rather than three
 * phrasings of one — a plan, a position report with a tank state, and an edit
 * — because their job is to show the range of what Penny takes, not to be
 * tapped verbatim. Keep in step with src/components/ChatPanel.tsx.
 */
const CHAT_STARTERS = [
  "Girona to Lisbon, 5 h days",
  "I'm in Reims, 150 km in the tank",
  "Add a rest day in Strasbourg",
] as const;

export default function ChatPanel({
  tripId,
  onboardingState,
  readonly,
  onTripUpdated,
  onActivity,
}: ChatPanelProps) {
  const { units } = useUnits();
  const { notify } = useErrors();
  const api = useMemo(() => tripApi(tripId), [tripId]);

  const isOnboarding = onboardingState !== "done" && !readonly;

  const [messages, setMessages] = useState<UIMessage[]>([]);
  // Latest messages, readable from listeners (the AppState reconcile) without
  // re-binding them on every message change.
  const messagesRef = useRef<UIMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  /* ── Paywall ────────────────────────────────────────────────────────────
   * Penny's own message in the transcript, with the purchase button inside her
   * bubble. Deliberately NOT a modal: the only modal in this flow is the
   * purchase sheet itself, which stands in for Apple's StoreKit sheet.
   *
   * The panel holds the whole entitlement payload rather than a boolean,
   * because everything shown — the message, the button label, the prices,
   * whether this build can complete a purchase at all — is server-authored and
   * arrives together. Nothing about the paywall is decided here.
   */
  const [entitlement, setEntitlement] = useState<EntitlementPayload | null>(null);
  const [purchaseSheetOpen, setPurchaseSheetOpen] = useState(false);

  /**
   * Null entitlement means "not asked yet / couldn't ask" — never a block. A
   * phone loses its network constantly; paywalling the app because one request
   * failed would lock out paying subscribers in a tunnel. Every route that
   * spends money gates itself server-side and answers 402, so being wrong in
   * this direction costs one bounced request and nothing else.
   */
  const paywalled = entitlement !== null && !entitlement.entitled;
  /**
   * Two of the four block reasons have nothing to sell. A capped account is our
   * ceiling, not the user's fault, and a revoked one cannot be bought back — so
   * the button is a mailto to a human, and the purchase sheet never opens.
   */
  const paywallSupportOnly =
    entitlement?.blockReason === "usage_cap" || entitlement?.blockReason === "revoked";

  /**
   * The send guard reads a ref, not the render value.
   *
   * `sendChatMessage` re-enters itself from its own `finally` to drain the
   * queued-message backlog, and that re-entry runs inside the closure captured
   * when the FIRST send started. If the paywall went up mid-turn (a 402 on this
   * very turn), the captured `paywalled` is still false and the drain would fire
   * the next queued message straight into a second 402. The ref is always
   * current.
   */
  const paywalledRef = useRef(false);
  useEffect(() => {
    paywalledRef.current = paywalled;
  }, [paywalled]);

  /**
   * The transcript as rendered: the stored messages, plus Penny's paywall
   * bubble whenever this account is blocked.
   *
   * Derived, not stored — see withPaywallNotice. `messages` stays exactly what
   * the server sent plus what this session sent, which is what every other
   * code path here (sending, queueing, the reconcile) reads.
   */
  const visibleMessages = useMemo(
    () => withPaywallNotice(messages, entitlement, tripId),
    [messages, entitlement, tripId]
  );

  /**
   * Ask on mount, and store the answer — nothing more.
   *
   * This effect used to also PUSH Penny's paywall bubble into `messages`, which
   * raced the history effect below: history lands with `setMessages(...)`, a
   * wholesale replace, so the bubble survived only when the entitlement request
   * happened to answer second. It was there on one visit to the chat and gone
   * on the next. The bubble is now derived from this state at render time
   * (`visibleMessages`), so the order these two requests resolve in no longer
   * decides whether the user is told they are blocked.
   *
   * A paywalled user reads that message and finds the composer already closed,
   * so the first thing they learn about their billing is never a red error
   * bubble bounced back off a request they were allowed to make. Skipped in
   * readonly (the demo trip), where the composer is replaced wholesale and
   * there is nothing to gate.
   */
  useEffect(() => {
    if (readonly) return;
    let cancelled = false;
    void (async () => {
      const payload = await fetchEntitlement();
      if (cancelled || !payload) return;
      setEntitlement(payload);
    })();
    return () => {
      cancelled = true;
    };
  }, [readonly]);

  /**
   * Turn a pending assistant bubble into the paywall bubble.
   *
   * This is the mid-conversation case: the trial can lapse between app open and
   * the next turn, so a send that was legal when the composer rendered comes
   * back 402. The 402 body carries the machine-readable reason but not the copy
   * or the prices — those live on `/api/me/entitlement` so they can change
   * without a store release — so re-ask, then rewrite the bubble in place. If
   * that second call fails too, the 402's own `error` string is still
   * server-written copy and beats inventing our own.
   */
  const showPaywallOnBubble = useCallback(
    async (assistantMsgId: string, body: Record<string, unknown> | null) => {
      const payload = await fetchEntitlement();
      if (payload) setEntitlement(payload);
      const fallback = typeof body?.error === "string" ? body.error : "";
      // Last resort, and only reachable when the 402 body carried no prose AND
      // the entitlement re-fetch also failed. Every word above it is
      // server-authored on purpose; this exists so that double failure produces
      // a bubble that says something rather than an empty one.
      const text =
        payload?.paywall?.message ||
        fallback ||
        "Your access to trip planning has ended. Reopen the app in a moment to see your options.";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? { ...m, content: text, streaming: false, applyError: null, paywall: true }
            : m
        )
      );
      // 'response', not 'error'. It is Penny answering, and the unread badge
      // should behave the way it does for anything else she says.
      onActivity("response");
    },
    [onActivity]
  );

  /**
   * The purchase, the wait for the webhook and the restore, all in one hook
   * shared with the overlay and the no-trips paywall screen.
   *
   * What is left here is the only part that is this screen's business: putting
   * the transcript back the way it was. A purchase does not navigate — the
   * paywall is a message in this conversation, so getting past it should leave
   * the conversation exactly where it was.
   */
  const onEntitled = useCallback((fresh: EntitlementPayload) => {
    setEntitlement(fresh);
    // The DERIVED bubble disappears on its own the moment `fresh` says
    // entitled. This clears the other kind: a real pending bubble that a
    // mid-turn 402 rewrote in place, which is a stored message and would
    // otherwise sit in the transcript telling a paying user they are blocked.
    setMessages((prev) => prev.filter((m) => !m.paywall));
    setPurchaseSheetOpen(false);
  }, []);

  const purchaseFlow = usePurchaseFlow({ entitlement, onEntitled });

  const [historyLoading, setHistoryLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const [input, setInput] = useState("");
  const [inputHeight, setInputHeight] = useState(34);
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [loading, setLoading] = useState(false);
  /** True while Penny's typing animation plays before an onboarding question. */
  const [introTyping, setIntroTyping] = useState(false);

  const [onboardingSnapshot, setOnboardingSnapshot] = useState<OnboardingSnapshot | null>(null);
  const [onboardingLoading, setOnboardingLoading] = useState(isOnboarding);
  const [onboardingSubmitting, setOnboardingSubmitting] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);

  /** Queue of messages sent while Penny is thinking — drained one at a time. */
  const messageQueueRef = useRef<Array<{ text: string; images: AttachedImage[]; msgId: string }>>(
    []
  );
  /** Live SSE handles, so unmount tears the sockets down instead of leaking. */
  const activeStreamsRef = useRef<Set<TurnStreamHandle>>(new Set());

  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  const didInitialScroll = useRef(false);
  const stickToBottom = useRef(true);
  const pendingRestoreScroll = useRef<{ prevHeight: number } | null>(null);
  const contentHeight = useRef(0);
  const prefilledQuestionKey = useRef<string | null>(null);
  /** False after unmount — an unmount-cancelled stream is not a real failure. */
  const mounted = useRef(true);

  const onboardingUiActive =
    isOnboarding && onboardingSnapshot !== null && onboardingSnapshot.state !== "done";
  const onboardingBlockingLoad = isOnboarding && onboardingLoading && !onboardingSnapshot;
  const onboardingQuestion: OnboardingQuestion | null = onboardingUiActive
    ? onboardingSnapshot.question
    : null;
  const onboardingSelectStep = Boolean(onboardingQuestion && onboardingQuestion.kind === "select");
  const attachImagesAllowed = !isOnboarding && !readonly;

  // ── scrolling ───────────────────────────────────────────────────────────
  //
  // A ScrollView, not an inverted FlatList. The web pins a short conversation
  // to the bottom with a `flex: 1` spacer above the messages while keeping the
  // top reachable; that trick ports verbatim to a ScrollView with
  // `contentContainerStyle={{ flexGrow: 1 }}` and a flexible spacer View.
  // Inverting a FlatList would instead require reversing the data (which
  // inverts the iMessage grouping calculation), a counter-scaleY on every row
  // (which fights Android text rendering), and a footer-as-header for "Load
  // older" — a lot of contortion to virtualize a transcript that is already
  // bounded by cursor pagination.
  const scrollToBottom = useCallback((instant?: boolean) => {
    scrollRef.current?.scrollToEnd({ animated: !instant });
  }, []);

  const handleContentSizeChange = useCallback((_w: number, h: number) => {
    const restore = pendingRestoreScroll.current;
    const prevHeight = contentHeight.current;
    contentHeight.current = h;

    // Older messages were just prepended — keep the viewport anchored to what
    // the user was reading instead of jumping to the top of the new batch.
    if (restore) {
      pendingRestoreScroll.current = null;
      scrollRef.current?.scrollTo({ y: h - restore.prevHeight, animated: false });
      return;
    }
    if (!didInitialScroll.current) {
      didInitialScroll.current = true;
      scrollRef.current?.scrollToEnd({ animated: false });
      return;
    }
    // Only follow new content when the user is already at the bottom. The web
    // scrolls unconditionally, which on a phone yanks you out of the history
    // you scrolled up to read every time a stream chunk lands.
    if (h !== prevHeight && stickToBottom.current) {
      scrollRef.current?.scrollToEnd({ animated: true });
    }
  }, []);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMore) return;
    // Optimistic messages have no `seq` (or seq=0). Walk from the front to find
    // the earliest persisted message with a real seq — that's our cursor.
    const earliest = messagesRef.current.find((m) => (m.seq ?? 0) > 0);
    if (!earliest?.seq) return;
    setLoadingOlder(true);
    pendingRestoreScroll.current = { prevHeight: contentHeight.current };
    try {
      const data = await api.listChat(earliest.seq);
      // Nothing came back — drop the anchor, or the next content-size change
      // (a new message) would be treated as the prepend and scroll wrongly.
      if (data.messages.length === 0) pendingRestoreScroll.current = null;
      setMessages((prev) => [...data.messages, ...prev]);
      setHasMore(data.hasMore);
    } catch (e) {
      console.warn("Failed to load older chat:", e);
      pendingRestoreScroll.current = null;
    } finally {
      setLoadingOlder(false);
    }
  }, [api, hasMore, loadingOlder]);

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      stickToBottom.current =
        contentSize.height - (contentOffset.y + layoutMeasurement.height) < 120;
      // ~40pt threshold feels natural under a thumb.
      if (contentOffset.y < 40 && hasMore && !loadingOlder) void loadOlder();
    },
    [hasMore, loadingOlder, loadOlder]
  );

  // ── initial history ─────────────────────────────────────────────────────
  // The web receives `initialMessages` from a server component; native has no
  // such thing, so the panel loads its own first page.
  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true);
    void (async () => {
      try {
        const data = await api.listChat();
        if (cancelled) return;
        setMessages(data.messages);
        setHasMore(data.hasMore);
      } catch {
        // The global error surface already reported it; an empty transcript is
        // still usable (the composer works).
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Tear down any live stream when the panel unmounts.
  useEffect(() => {
    const streams = activeStreamsRef.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const s of streams) s.cancel();
      streams.clear();
    };
  }, []);

  // Keep the newest message visible when the keyboard slides up.
  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidShow", () => {
      if (stickToBottom.current) scrollToBottom();
    });
    return () => sub.remove();
  }, [scrollToBottom]);

  // "Add to this day" on a rest-day LegCard — the native stand-in for the web's
  // `penny:prefill` CustomEvent. Same contract: prefill the composer, focus it,
  // and scroll down so the user sees what they're about to send.
  useEffect(() => {
    return onPennyPrefill((detail) => {
      const locationStr = detail.location || "this location";
      setInput(
        `I want to add plans for ${detail.dayTitle} in ${locationStr} — what should I do there?`
      );
      inputRef.current?.focus();
      scrollToBottom();
    });
  }, [scrollToBottom]);

  // While a turn is in flight but Penny hasn't streamed any text yet, show the
  // bare typing dots.
  const pennyStreamingText = messages.some(
    (m) => m.id?.startsWith("optimistic-") && m.role === "assistant" && m.streaming && !!m.content
  );
  const replanWaiting = loading && !pennyStreamingText;
  /*
   * Whether the identity strip reads THINKING or READY. Deliberately the SAME
   * expression the transcript's TypingBubble uses, plus the streaming case —
   * a strip saying READY while three dots bounced would be worse than no
   * strip at all. Mirrors src/components/ChatPanel.tsx.
   */
  const pennyThinking = introTyping || replanWaiting || !!pennyStreamingText;

  // ── applying / healing a turn ───────────────────────────────────────────

  /**
   * Apply a terminal `applied` payload to an assistant bubble — the single code
   * path shared by the live stream and the reconcile/heal flow, so a healed turn
   * renders identically to one seen live. Reloads the trip when something
   * changed.
   */
  const applyAppliedEvent = useCallback(
    (assistantMsgId: string, ev: AppliedEvent) => {
      const outcome = deriveApplyOutcome(ev);
      if (outcome.applyError && outcome.validationFailures.length > 0) {
        // Validation details are technical (Zod errors aimed at the LLM) — log,
        // don't surface.
        console.warn("[Penny] validation failures:", outcome.validationFailures);
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                content: ev.response || m.content,
                changes_made:
                  ev.appliedCount > 0 ? JSON.stringify(ev.changes ?? { changes: [] }) : null,
                applyError: outcome.applyError,
                partialApplyWarning: outcome.partialApplyWarning,
                plan_summary: ev.planSummary ?? null,
                truncated: ev.truncated,
                streaming: false,
              }
            : m
        )
      );
      if (outcome.appliedChanges || ev.fuelStopsChanged) onTripUpdated();
      onActivity(outcome.applyError ? "error" : "response");
    },
    [onTripUpdated, onActivity]
  );

  /** Put an assistant bubble into a stable error state (mirrors failAssistant). */
  const setBubbleError = useCallback((assistantMsgId: string, msg: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantMsgId
          ? {
              ...m,
              content: m.content || msg,
              streaming: false,
              applyError: m.content ? msg : null,
            }
          : m
      )
    );
  }, []);

  /**
   * Re-attach to a turn's durable record and heal the bubble. Returns the
   * terminal disposition; callers poll while it's still `pending`.
   *
   * This is the core of the crash-heal, and it matters MORE on a phone than on
   * the web: iOS suspends a backgrounded app outright, which kills the socket
   * mid-turn. The server does not stop — it finishes and records Penny's reply
   * — so on the way back in we read that record and replace the false
   * "Something went wrong" with her real answer.
   *
   * Note the shape difference from the web: the native /turns endpoint returns
   * the PERSISTED assistant message rather than the raw `result_meta`, so the
   * heal reads content / changes_made / plan_summary straight off it.
   */
  const reconcileTurn = useCallback(
    async (
      assistantMsgId: string,
      key: string
    ): Promise<"done" | "error" | "pending" | "unknown"> => {
      try {
        const data = await api.getTurn(key);
        const turn = data?.turn ?? null;
        if (!turn) return "unknown";
        if (turn.status === "done") {
          const persisted = turn.assistantMessage ?? null;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    content: persisted?.content || m.content,
                    changes_made: persisted?.changes_made ?? m.changes_made,
                    plan_summary: persisted?.plan_summary ?? m.plan_summary ?? null,
                    // The turn landed after all — clear the client-only error.
                    applyError: null,
                    streaming: false,
                  }
                : m
            )
          );
          if (persisted?.changes_made) onTripUpdated();
          onActivity("response");
          return "done";
        }
        if (turn.status === "error") {
          setBubbleError(
            assistantMsgId,
            turn.error ? `Error: ${turn.error}` : "Something went wrong while updating your trip."
          );
          onActivity("error");
          return "error";
        }
        return "pending";
      } catch {
        return "unknown";
      }
    },
    [api, setBubbleError, onTripUpdated, onActivity]
  );

  /**
   * Poll a turn to completion. Used for a turn the server QUEUED behind another
   * (no stream of its own) and as the heal path after a dropped stream. Bounded
   * so it can't poll forever; gives up after a run of `unknown` reads (the row
   * is gone) or the deadline.
   */
  const pollTurnUntilTerminal = useCallback(
    async (
      assistantMsgId: string,
      key: string,
      opts?: { timeoutMs?: number }
    ): Promise<"done" | "error" | "timeout"> => {
      const deadline = Date.now() + (opts?.timeoutMs ?? 5 * 60 * 1000);
      let unknowns = 0;
      while (Date.now() < deadline) {
        const d = await reconcileTurn(assistantMsgId, key);
        if (d === "done" || d === "error") return d;
        if (d === "unknown") {
          unknowns += 1;
          if (unknowns >= 3) return "timeout";
        } else {
          unknowns = 0;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      return "timeout";
    },
    [reconcileTurn]
  );

  // Reconcile on foreground — the RN equivalent of the web's `visibilitychange`
  // / `focus` listeners. Any assistant bubble still streaming or stuck on a
  // client-only error (with a known turn key) is re-checked against the durable
  // record, so a turn that landed while the phone was asleep silently replaces
  // the false error with Penny's real reply.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      const candidates = messagesRef.current.filter(
        (m) => m.role === "assistant" && !!m.turnKey && (m.streaming || !!m.applyError)
      );
      for (const m of candidates) {
        if (m.turnKey) void reconcileTurn(m.id, m.turnKey);
      }
    });
    return () => sub.remove();
  }, [reconcileTurn]);

  /**
   * Beacon a client-only stream failure so it lands in /admin/errors, and
   * return a short user-facing code. These failures — dominated by the app
   * being backgrounded mid-turn, which tears the socket down — would otherwise
   * be a black hole. Fire-and-forget: diagnostics must never break the chat.
   * The SERVER already persists its own errors, so we only beacon the
   * client-side paths it can't see.
   *
   * The web uses `fetch(..., { keepalive: true })` so the beacon survives page
   * unload. RN has no keepalive and no unload — the OS just freezes the
   * process — so this is best-effort by construction.
   */
  const reportStreamError = useCallback(
    (phase: "stream-threw" | "stream-incomplete", err?: unknown): string => {
      const code = `S-${Math.random().toString(36).slice(2, 8)}`;
      const message = err instanceof Error ? err.message : err != null ? String(err) : undefined;
      const hidden = AppState.currentState !== "active";
      void (async () => {
        try {
          await fetch(`${API_BASE_URL}/api/analytics/client-error`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(await authHeaders()) },
            body: JSON.stringify({
              tripId,
              code,
              phase,
              message: message?.slice(0, 500),
              hidden,
            }),
          });
        } catch {
          // never let diagnostics break the UI
        }
      })();
      return code;
    },
    [tripId]
  );

  // ── the send engine ─────────────────────────────────────────────────────
  //
  // Shared inner engine for "user said X → Penny replies". `sendMessage` is the
  // composer path (pulls from input/images state); the onboarding handoff calls
  // this directly with the first real user message. The explicit type
  // annotation is what lets the `finally` block re-enter it to drain the queue
  // without TS complaining about a self-referential initializer.
  const sendChatMessage: (
    trimmed: string,
    attachedImages?: AttachedImage[],
    /** When draining the queue, pass the existing optimistic id to reuse it. */
    existingUserMsgId?: string,
    /** Only true for the post-onboarding full-trip build. */
    insertPlanningNotice?: boolean
  ) => Promise<void> = async (
    trimmed,
    attachedImages = [],
    existingUserMsgId,
    insertPlanningNotice = false
  ) => {
    // The one choke point every send passes through — the composer, the queue
    // drain, the truncated bubble's "Continue planning", the onboarding
    // handoff. The composer is already closed behind the paywall; this is what
    // makes it impossible for the other three to fire a request whose only
    // possible answer is a 402. It returns before any optimistic bubble is
    // appended, so a blocked send leaves no half-sent message behind.
    if (paywalledRef.current) return;
    if (!trimmed && attachedImages.length === 0) return;

    const userMsgId = existingUserMsgId ?? `optimistic-${Date.now()}`;
    const assistantMsgId = `optimistic-${Date.now() + 1}`;
    // Stable id for this send: the idempotency anchor for the durable turn
    // record AND the key we use to re-attach and heal if the stream drops. A
    // retry carrying the same key returns the existing turn instead of spawning
    // a second replan.
    const idempotencyKey = Crypto.randomUUID();

    if (existingUserMsgId) {
      // Reuse the queued user bubble — update its status and append the pending
      // assistant bubble after it.
      setMessages((prev) => [
        ...prev.map((m) =>
          m.id === existingUserMsgId ? { ...m, deliveryStatus: "sending" as DeliveryStatus } : m
        ),
        {
          id: assistantMsgId,
          trip_id: tripId,
          role: "assistant" as const,
          content: "",
          kind: "ai" as const,
          changes_made: null,
          created_at: new Date().toISOString(),
          streaming: true,
          turnKey: idempotencyKey,
        },
      ]);
    } else {
      const tempUserMsg: UIMessage = {
        id: userMsgId,
        trip_id: tripId,
        role: "user",
        content: trimmed,
        kind: "ai",
        changes_made: null,
        created_at: new Date().toISOString(),
        imageDataUrls: attachedImages.map((i) => i.dataUrl),
        deliveryStatus: "sending",
      };
      const pendingAssistantMsg: UIMessage = {
        id: assistantMsgId,
        trip_id: tripId,
        role: "assistant",
        content: "",
        kind: "ai",
        changes_made: null,
        created_at: new Date().toISOString(),
        streaming: true,
        turnKey: idempotencyKey,
      };
      const planningNotice: UIMessage | null = insertPlanningNotice
        ? {
            id: `penny-planning-${Date.now() + 2}`,
            trip_id: tripId,
            role: "assistant",
            content: PLANNING_VIDEO_COPY,
            kind: "ai",
            changes_made: null,
            created_at: new Date().toISOString(),
          }
        : null;
      setMessages((prev) => [
        ...prev,
        tempUserMsg,
        ...(planningNotice ? [planningNotice] : []),
        pendingAssistantMsg,
      ]);
    }

    setLoading(true);
    onActivity("thinking");

    /** Append a chunk of streamed text to the in-progress assistant bubble. */
    const appendText = (chunk: string) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                // Blank line between paragraphs so the iteration boundaries read
                // as natural breaks instead of running on.
                content: m.content ? `${m.content}\n\n${chunk}` : chunk,
              }
            : m
        )
      );
    };

    /** Update the delivery status on this send's user message. */
    const setDeliveryStatus = (status: DeliveryStatus) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === userMsgId ? { ...m, deliveryStatus: status } : m))
      );
    };

    /** Produce a stable error bubble when the stream collapses. */
    const failAssistant = (msg: string) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                content: m.content || msg,
                streaming: false,
                applyError: m.content ? msg : null,
              }
            : m
        )
      );
    };

    let stream: TurnStreamHandle | null = null;
    try {
      stream = startTurnStream({
        body: {
          tripId,
          message: trimmed,
          images: attachedImages.map((i) => ({ dataUrl: i.dataUrl, mediaType: i.mediaType })),
          idempotencyKey,
        },
        headers: await authHeaders(),
        handlers: {
          onReceived: () => setDeliveryStatus("delivered"),
          onReading: () => setDeliveryStatus("read"),
          onText: (chunk) => {
            setDeliveryStatus("typing");
            appendText(chunk);
          },
        },
      });
      activeStreamsRef.current.add(stream);
      const res = await stream.result;
      activeStreamsRef.current.delete(stream);

      if (res.outcome === "applied") {
        // Authoritative result. `applyAppliedEvent` is the single path shared
        // with reconcile/heal, so a live turn and a healed one render
        // identically (and it reloads the trip when something changed).
        setDeliveryStatus("responded");
        applyAppliedEvent(assistantMsgId, res.event);
        return;
      }

      if (res.outcome === "http-error") {
        // ...except 402, which is not a failure the user caused and must never
        // render as "Something went wrong". The trial can lapse between app
        // open and this turn, so a send that was legal when the composer
        // rendered comes back paywalled — Penny says so herself, in the bubble
        // that was about to hold her reply. Branch on the machine-readable
        // `code` that turnStream parsed out of the body, never on the message:
        // the message is copy and copy changes.
        if (res.status === 402 && res.body?.code === PAYWALL_ERROR_CODE) {
          setDeliveryStatus("responded");
          await showPaywallOnBubble(assistantMsgId, res.body);
          return;
        }

        // Every other pre-stream error (rate limit, validation, missing key).
        setDeliveryStatus("responded");
        failAssistant(`Error: ${res.message}`);
        onActivity("error");
        return;
      }

      if (res.outcome === "stream-error") {
        // The server told us the turn failed; the durable record says the same,
        // so there is nothing to heal.
        setDeliveryStatus("responded");
        failAssistant(res.message);
        onActivity("error");
        return;
      }

      if (res.outcome === "silent") {
        // The server answered with JSON instead of a stream: our turn was
        // queued behind another, or this exact send was already accepted
        // (idempotent replay). Poll the durable record until it lands.
        setDeliveryStatus("read");
        const result = await pollTurnUntilTerminal(assistantMsgId, idempotencyKey);
        setDeliveryStatus("responded");
        if (result === "timeout") {
          failAssistant(
            "Penny is taking longer than expected. Your message is saved — reopen the trip in a moment to see her reply."
          );
          onActivity("error");
        }
        return;
      }

      // outcome === 'dropped'. If WE closed the socket by unmounting, there is
      // nothing to report or heal — the bubble is gone with the panel.
      if (!mounted.current) return;
      // Otherwise: almost always the app backgrounded mid-turn.
      // The server keeps running and records Penny's reply regardless, so
      // reconcile from the durable record and HEAL the bubble instead of
      // dead-ending on "try again".
      const code = reportStreamError("stream-incomplete", res.detail);
      const healed = await pollTurnUntilTerminal(assistantMsgId, idempotencyKey, {
        timeoutMs: 20000,
      });
      setDeliveryStatus("responded");
      if (healed === "done" || healed === "error") return;
      failAssistant(
        `Connection dropped before Penny finished (code ${code}). Your partial response is above; please retry.`
      );
      onActivity("error");
    } catch (err) {
      // We couldn't even open the socket (no token, bad URL, EventSource threw).
      console.warn("replan stream errored", err);
      if (stream) activeStreamsRef.current.delete(stream);
      const code = reportStreamError("stream-threw", err);
      setDeliveryStatus("responded");
      const healed = await pollTurnUntilTerminal(assistantMsgId, idempotencyKey, {
        timeoutMs: 20000,
      });
      if (healed !== "done" && healed !== "error") {
        // Couldn't confirm within the window — leave an accurate, non-alarming
        // message. The foreground reconcile heals it later if it lands.
        failAssistant(
          `Connection interrupted (code ${code}). Penny may still be finishing — reopen the trip in a moment to see her reply.`
        );
        onActivity("error");
      }
    } finally {
      setLoading(false);
      // Drain the queue — send the next message now that Penny is free. One at
      // a time: each call re-enters this finally block and drains the next.
      const next = messageQueueRef.current.shift();
      if (next) {
        // Small delay so the UI can render setLoading(false) before the next
        // stream starts.
        await new Promise((r) => setTimeout(r, 50));
        void sendChatMessage(next.text, next.images, next.msgId);
      }
    }
  };

  // ── onboarding ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isOnboarding) {
      setOnboardingSnapshot(null);
      setOnboardingError(null);
      return;
    }
    let cancelled = false;
    setOnboardingLoading(true);
    void (async () => {
      try {
        const data = await api.getOnboarding();
        if (cancelled) return;
        setOnboardingSnapshot(data);
        setOnboardingError(null);
      } catch (e: unknown) {
        if (!cancelled) setOnboardingError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setOnboardingLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, isOnboarding]);

  // Typing animation before each onboarding question, then the question lands
  // as a Penny bubble — so trip setup reads like a conversation, not a form.
  useEffect(() => {
    if (
      !isOnboarding ||
      onboardingLoading ||
      !onboardingSnapshot ||
      onboardingSnapshot.state === "done"
    ) {
      return;
    }
    const q = onboardingSnapshot.question;
    if (!q) return;

    const addQuestionBubble = () => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.kind === "form_question" && last.content === q.label) return prev;
        return [
          ...prev,
          {
            id: `optimistic-${Date.now()}`,
            trip_id: tripId,
            role: "assistant" as const,
            content: q.label,
            kind: "form_question" as const,
            changes_made: null,
            created_at: new Date().toISOString(),
          },
        ];
      });
    };

    // The first question follows the longer greeting, so it gets 3s; every
    // later one gets 2s.
    const isFirstQuestion =
      onboardingSnapshot.state === "trip_intent" && messagesRef.current.length === 0;
    const delay = isFirstQuestion ? 3000 : 2000;
    setIntroTyping(true);
    const timer = setTimeout(() => {
      setIntroTyping(false);
      addQuestionBubble();
    }, delay);
    return () => clearTimeout(timer);
  }, [isOnboarding, onboardingLoading, onboardingSnapshot, tripId]);

  // A question can arrive with a prefilled answer (e.g. a start date we pulled
  // out of the trip description) — drop it into the composer once, keyed on
  // question identity so we don't clobber edits or re-fill after a clear.
  useEffect(() => {
    const q = onboardingQuestion;
    if (q?.defaultValue && prefilledQuestionKey.current !== q.key) {
      prefilledQuestionKey.current = q.key;
      setInput(q.defaultValue);
    }
  }, [onboardingQuestion]);

  useEffect(() => {
    if (isOnboarding) setImages([]);
  }, [isOnboarding]);

  const submitOnboardingAnswer = async (questionKey: string, value: string | number) => {
    if (!onboardingSnapshot?.question || onboardingSubmitting) return;
    setOnboardingSubmitting(true);
    setOnboardingError(null);
    try {
      const result = await api.answerOnboarding(questionKey, value);
      if (result.didHandoff) {
        setOnboardingSnapshot({ state: "done", question: null, vehicles: [], progress: null });
        setInput("");
        // Surface any deterministic acknowledgment (e.g. the start-date confirm
        // / placeholder) as a Penny bubble before her real planning response.
        if (result.note) {
          const note = result.note;
          setMessages((prev) => [
            ...prev,
            {
              id: `optimistic-${Date.now()}`,
              trip_id: tripId,
              role: "assistant" as const,
              content: note,
              kind: "ai" as const,
              changes_made: null,
              created_at: new Date().toISOString(),
            },
          ]);
        }
        // Fire the STORED trip intent at Penny — not the last answer, which was
        // whatever the final setup question asked about. This handoff turn is
        // the full-trip build, the one wait we know will be long.
        const intent = result.tripIntent ?? (typeof value === "string" ? value : String(value));
        await sendChatMessage(intent, [], undefined, true);
        onTripUpdated();
      } else {
        const ts = Date.now();
        const note = result.note;
        setMessages((prev) => {
          const additions: UIMessage[] = [
            {
              id: `optimistic-${ts}`,
              trip_id: tripId,
              role: "user" as const,
              content: result.answerLabel,
              kind: "form_answer" as const,
              changes_made: null,
              created_at: new Date().toISOString(),
            },
          ];
          if (note) {
            additions.push({
              id: `optimistic-${ts + 1}`,
              trip_id: tripId,
              role: "assistant" as const,
              content: note,
              kind: "ai" as const,
              changes_made: null,
              created_at: new Date().toISOString(),
            });
          }
          return [...prev, ...additions];
        });
        setOnboardingSnapshot(result.next);
        setInput("");
      }
    } catch (e: unknown) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      // Show the user's answer and Penny's error as chat bubbles so the
      // conversation flow is visible, rather than a tiny error label near the
      // composer that's easy to miss.
      const answerLabel = typeof value === "string" ? value : String(value);
      setMessages((prev) => [
        ...prev,
        {
          id: `optimistic-${Date.now()}`,
          trip_id: tripId,
          role: "user" as const,
          content: answerLabel,
          kind: "form_answer" as const,
          changes_made: null,
          created_at: new Date().toISOString(),
        },
        {
          id: `optimistic-${Date.now() + 1}`,
          trip_id: tripId,
          role: "assistant" as const,
          content: errorMsg,
          kind: "ai" as const,
          changes_made: null,
          created_at: new Date().toISOString(),
        },
      ]);
      setInput("");
    } finally {
      setOnboardingSubmitting(false);
    }
  };

  const submitOnboardingPick = async (rawValue: string | number) => {
    const q = onboardingSnapshot?.question;
    if (!q || onboardingSubmitting || onboardingLoading) return;
    if (q.kind !== "select") return;
    await submitOnboardingAnswer(q.key, rawValue);
  };

  const submitOnboardingTextAnswer = async (trimmed: string) => {
    const q = onboardingSnapshot?.question;
    if (!q || onboardingSubmitting || onboardingLoading) return;

    if (q.kind === "handoff") {
      if (!trimmed) {
        setOnboardingError("Please describe your trip.");
        return;
      }
      await submitOnboardingAnswer(q.key, trimmed);
      return;
    }
    /*
     * A `chips` step is answered EITHER by tapping a shortcut or by TYPING,
     * and this is the typed half. Without it a chips question fell through
     * this function and did nothing: the composer took the text, send looked
     * like it worked, and the answer was never submitted — the exact case the
     * kind exists for, since "the second week of June" is a valid start date
     * and no chip can express it.
     *
     * BOUNDS decide the validation. The range question's 300/500/700 chips
     * carry them (200–1500) and are numeric; the date question's phrases do
     * not and are free text. They also produce the inline "Must be at least
     * 200", the only place a driver learns the floor before being rejected.
     *
     * Mirrors src/components/ChatPanel.tsx — the two share no code.
     */
    const numericChips =
      q.kind === "chips" && (q.min !== undefined || q.max !== undefined);

    if (q.kind === "text" || (q.kind === "chips" && !numericChips)) {
      if (!trimmed) {
        setOnboardingError("This one is required.");
        return;
      }
      await submitOnboardingAnswer(q.key, trimmed);
      return;
    }
    if (q.kind === "number" || q.kind === "integer" || numericChips) {
      if (!trimmed) {
        setOnboardingError("This one is required.");
        return;
      }
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        setOnboardingError("Please enter a number.");
        return;
      }
      if (q.kind === "integer" && !Number.isInteger(n)) {
        setOnboardingError("Please enter a whole number.");
        return;
      }
      if (q.min !== undefined && n < q.min) {
        setOnboardingError(`Must be at least ${q.min}.`);
        return;
      }
      if (q.max !== undefined && n > q.max) {
        setOnboardingError(`Must be at most ${q.max}.`);
        return;
      }
      await submitOnboardingAnswer(q.key, n);
    }
  };

  // ── composer ────────────────────────────────────────────────────────────

  const pickImages = async () => {
    // Drag-and-drop and paste have no phone equivalent — the picker is the only
    // attach path.
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      notify("Photo access is off — turn it on in Settings to attach images.");
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      base64: true,
      quality: 0.8,
      allowsMultipleSelection: true,
      selectionLimit: 4,
    });
    if (res.canceled) return;
    const next: AttachedImage[] = [];
    for (const asset of res.assets) {
      if (!asset.base64) continue;
      // base64 inflates by 4/3; prefer the real file size when the picker knows it.
      const bytes = asset.fileSize ?? Math.floor((asset.base64.length * 3) / 4);
      if (bytes > MAX_IMAGE_BYTES) {
        notify(`Skipping ${asset.fileName ?? "image"}: > 8 MB`);
        continue;
      }
      const mediaType = asset.mimeType ?? "image/jpeg";
      next.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        dataUrl: `data:${mediaType};base64,${asset.base64}`,
        mediaType,
        name: asset.fileName ?? "screenshot",
      });
    }
    if (next.length) setImages((prev) => [...prev, ...next]);
  };

  const removeImage = (id: string) => setImages((prev) => prev.filter((i) => i.id !== id));

  // Thin wrapper — the composer path pulls text/images out of local state,
  // clears them, and delegates to the shared engine.
  const sendMessage = async () => {
    // Belt to the engine's braces. The field is not editable and the send
    // button is disabled behind the paywall, but returning here as well means a
    // stray send can't park a message in the queue either — which would fire
    // the moment an in-flight turn finished, long after the user read why they
    // were blocked.
    if (paywalled) return;
    const trimmed = input.trim();
    const attachedImages = images;
    if (onboardingUiActive) {
      if (onboardingLoading || onboardingSubmitting) return;
      if (!onboardingSnapshot?.question) return;
      if (onboardingSelectStep) return;
      if (!trimmed && attachedImages.length === 0) return;
      if (attachedImages.length > 0) {
        setOnboardingError("Images aren't available during trip setup.");
        return;
      }
      await submitOnboardingTextAnswer(trimmed);
      return;
    }
    if (!trimmed && attachedImages.length === 0) return;
    setInput("");
    setImages([]);
    setInputHeight(34);

    if (loading) {
      // Penny is still thinking — queue this message to send when she finishes.
      const queuedMsgId = `optimistic-${Date.now()}`;
      messageQueueRef.current.push({ text: trimmed, images: attachedImages, msgId: queuedMsgId });
      setMessages((prev) => [
        ...prev,
        {
          id: queuedMsgId,
          trip_id: tripId,
          role: "user" as const,
          content: trimmed,
          kind: "ai" as const,
          changes_made: null,
          created_at: new Date().toISOString(),
          imageDataUrls: attachedImages.map((i) => i.dataUrl),
          deliveryStatus: "queued" as DeliveryStatus,
        },
      ]);
      return;
    }
    await sendChatMessage(trimmed, attachedImages);
  };

  const onboardingComposerBusy = onboardingUiActive && (onboardingLoading || onboardingSubmitting);
  // Only the *loading* states disable the field — not submitting. Disabling it
  // mid-submit blurs it, which closes the keyboard and breaks the back-and-forth
  // feel. Double-submit is already guarded by early returns.
  const onboardingComposerDisabled = onboardingUiActive && (onboardingLoading || introTyping);
  const hasComposerText = input.trim().length > 0;
  const sendEnabled =
    !paywalled &&
    !onboardingComposerBusy &&
    ((!onboardingUiActive && (hasComposerText || images.length > 0)) ||
      (onboardingUiActive && !!onboardingQuestion && !onboardingSelectStep && hasComposerText));

  const placeholder = paywalled
    ? // Deliberately points AT Penny's message rather than restating it — there
      // is exactly one authoritative wording for why this is closed, it is in
      // the bubble above, and it was written by the server.
      "See Penny's message above"
    : onboardingSelectStep
      ? "Tap an option above…"
      : onboardingUiActive && onboardingQuestion
        ? (onboardingQuestion.placeholder ?? "Type your answer…")
        : "Ask Penny…";

  return (
    /*
     * A plain View. The keyboard container lives at the SCREEN root, in
     * app/trips/[tripId].tsx — see the long note there. It cannot work from
     * inside this component: ChatPanel is rendered into an absolutely-
     * positioned pane, and KeyboardAvoidingView measures a parent-relative
     * frame against a screen-relative keyboard position, so from here the
     * subtraction clamps to zero and no padding is ever applied.
     */
    <View style={styles.root}>
      {/*
        Penny's identity strip. The avatar was a flat primary circle standing
        in for the web's primary→success gradient; under the mono palette those
        two stops are the same colour, so both sides are a ring now — which
        also stops it reading as the account avatar in the header above.
      */}
      <View style={styles.header}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>P</Text>
        </View>
        <View style={styles.headerCopy}>
          <Text style={styles.headerName}>Penny</Text>
          <Text style={styles.headerSub}>Feral Travels AI · plans your days</Text>
        </View>
        <View style={styles.headerStatus}>
          <View style={[styles.statusDot, pennyThinking && styles.statusDotThinking]} />
          <Text style={[styles.statusText, pennyThinking && styles.statusTextThinking]}>
            {pennyThinking ? "THINKING" : "READY"}
          </Text>
        </View>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        onScroll={handleScroll}
        scrollEventThrottle={64}
        onContentSizeChange={handleContentSizeChange}
        // Without this, the first tap while the keyboard is up only dismisses
        // it — the native equivalent of the web's `onMouseDown preventDefault`
        // on every composer button.
        keyboardShouldPersistTaps="handled"
      >
        {/* Spacer: pushes messages to the bottom (like iMessage) when there are
            only a few. `flex: 1` absorbs leftover space but collapses to zero
            once the messages overflow — so the first message stays reachable. */}
        <View style={styles.spacer} />

        {historyLoading ? (
          <View style={styles.historyLoading}>
            <Spinner />
          </View>
        ) : null}

        {hasMore ? (
          <View style={styles.loadOlderRow}>
            {loadingOlder ? (
              <Text style={styles.loadOlderLabel}>Loading older messages…</Text>
            ) : (
              <Pressable onPress={() => void loadOlder()} style={styles.loadOlderButton}>
                <Text style={styles.loadOlderButtonText}>Load older</Text>
              </Pressable>
            )}
          </View>
        ) : null}

        {/*
          The empty state. The panel rendered nothing at all — a chat screen
          with no indication of what to type, which is the moment a new user
          decides whether this app does anything.

          The rows PREFILL the composer and focus it rather than sending: the
          examples are shapes to edit, not messages anyone wants verbatim.
        */}
        {messages.length === 0 && !onboardingUiActive ? (
          <View style={styles.starterBlock}>
            <Text style={styles.starterKicker}>START HERE</Text>
            <Text style={styles.starterHeadline}>
              Tell Penny where you&apos;re going and how far you want to drive each day.
            </Text>
            {CHAT_STARTERS.map((starter) => (
              <Pressable
                key={starter}
                onPress={() => {
                  setInput(starter);
                  inputRef.current?.focus();
                }}
                style={styles.starterRow}
              >
                <Text style={styles.starterText}>&ldquo;{starter}&rdquo;</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {visibleMessages.map((msg, msgIdx) => {
          // Hide the empty assistant bubble while Penny is working but hasn't
          // emitted any text yet — the 3-dot indicator covers that state. The
          // web only checks `streaming`; we also drop a finished-but-empty
          // bubble, which is what a heal produces when the durable record has
          // no persisted assistant message to read back.
          if (
            msg.role === "assistant" &&
            !msg.content &&
            !msg.changes_made &&
            !msg.plan_summary &&
            !msg.applyError &&
            !msg.truncated &&
            // A paywall bubble is never hidden. Its content is server copy, and
            // the one path that could arrive empty (a 402 whose body carried no
            // prose AND an entitlement re-fetch that failed) is exactly the path
            // where dropping the bubble would leave the user staring at a
            // question that got no answer at all.
            !msg.paywall
          ) {
            return null;
          }

          const gp = getGroupPosition(visibleMessages, msgIdx);
          // Tight 2pt gap inside a group, 10pt between groups.
          const marginTop = msgIdx === 0 ? 0 : gp.isFirst ? 10 : 2;
          const isUser = msg.role === "user";
          const isQueued = msg.deliveryStatus === "queued";
          const isLastUserMessage =
            isUser && !visibleMessages.slice(msgIdx + 1).some((m) => m.role === "user");

          return (
            <View
              key={msg.id}
              style={[
                styles.row,
                { marginTop, alignSelf: isUser ? "flex-end" : "flex-start" },
                isQueued ? styles.queued : null,
              ]}
            >
              <View
                style={[
                  styles.bubble,
                  bubbleRadius(msg.role, gp),
                  isUser ? styles.bubbleUser : styles.bubbleAssistant,
                ]}
              >
                {msg.imageDataUrls && msg.imageDataUrls.length > 0 ? (
                  <View style={[styles.bubbleImages, msg.content ? styles.bubbleImagesGap : null]}>
                    {msg.imageDataUrls.map((url, i) => (
                      <Image key={i} source={{ uri: url }} style={styles.bubbleImage} />
                    ))}
                  </View>
                ) : null}

                {msg.paywall ? (
                  <PaywallText text={msg.content} />
                ) : msg.content ? (
                  <Text style={styles.bubbleText}>
                    {msg.content}
                    {msg.streaming ? <BlinkingCursor /> : null}
                  </Text>
                ) : null}

                {msg.changes_made && !msg.applyError ? (
                  <View style={styles.appliedNote}>
                    <Text style={styles.appliedNoteText}>Changes applied to trip</Text>
                  </View>
                ) : null}

                {/* Deterministic, DB-derived facts — never Penny's prose. */}
                {msg.plan_summary && !msg.applyError ? (
                  <PlanSummaryCard summary={msg.plan_summary} units={units} />
                ) : null}

                {msg.partialApplyWarning ? (
                  <View style={styles.partialNote}>
                    <Text style={styles.partialNoteText}>{msg.partialApplyWarning}</Text>
                  </View>
                ) : null}

                {msg.applyError ? (
                  <View style={styles.errorNote}>
                    <Text style={styles.errorNoteText}>{msg.applyError}</Text>
                  </View>
                ) : null}

                {msg.truncated ? (
                  <View style={styles.truncatedCard}>
                    <Text style={styles.truncatedTitle}>Penny didn&apos;t finish your plan</Text>
                    <Text style={styles.truncatedBody}>
                      She hit her planning step limit mid-plan and saved partial work. Click below to
                      keep going from where she stopped.
                    </Text>
                    <Pressable
                      onPress={() => void sendChatMessage(CONTINUE_PROMPT)}
                      disabled={loading}
                      style={[styles.continueButton, loading ? styles.continueButtonOff : null]}
                    >
                      <Text
                        style={[
                          styles.continueButtonText,
                          loading ? styles.continueButtonTextOff : null,
                        ]}
                      >
                        Continue planning
                      </Text>
                    </Pressable>
                  </View>
                ) : null}

                {/* The paywall's action, inside Penny's bubble — the same shape
                    as the truncated card's "Continue planning" above: her
                    words, then the one thing to do about them. The label is the
                    server's, so the button says "Renew" or "Email support"
                    without this file knowing which. It renders only once we
                    hold the payload; if the entitlement call failed we still
                    show her message and simply have no prices to offer. */}
                {msg.paywall && entitlement?.paywall ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      if (paywallSupportOnly) {
                        // Nothing to sell. A capped account is our ceiling and a
                        // revoked one can't be bought back, so this goes to a
                        // human rather than to a price list.
                        void Linking.openURL(`mailto:${SUPPORT_EMAIL}`);
                        return;
                      }
                      purchaseFlow.clearMessages();
                      setPurchaseSheetOpen(true);
                    }}
                    style={[
                      styles.paywallButton,
                      paywallSupportOnly ? styles.paywallButtonQuiet : null,
                    ]}
                  >
                    <Text
                      style={[
                        styles.paywallButtonText,
                        paywallSupportOnly ? styles.paywallButtonTextQuiet : null,
                      ]}
                    >
                      {entitlement.paywall.buttonLabel}
                    </Text>
                  </Pressable>
                ) : null}
              </View>

              {/* Delivery receipt — iMessage shows status on the last user
                  message only, not every message. */}
              {isLastUserMessage && msg.deliveryStatus ? (
                <Text
                  style={[
                    styles.receipt,
                    msg.deliveryStatus === "read" ? styles.receiptRead : null,
                  ]}
                >
                  {msg.deliveryStatus === "queued"
                    ? "Queued"
                    : msg.deliveryStatus === "sending"
                      ? "Sending…"
                      : msg.deliveryStatus === "delivered"
                        ? "Delivered"
                        : // typing and responded both stay on "Read" so the
                          // receipt doesn't flicker away while Penny streams —
                          // the 3-dot bubble is the typing indicator.
                          "Read"}
                </Text>
              ) : null}
            </View>
          );
        })}

        {/* Shown when Penny has "read" the message but hasn't started
            responding, and during the typing animation before each onboarding
            question. */}
        {introTyping || replanWaiting ? <TypingBubble /> : null}
      </ScrollView>

      {/* Attachment thumbnails */}
      {images.length > 0 && !isOnboarding ? (
        <View style={styles.thumbRow}>
          {images.map((img) => (
            <View key={img.id} style={styles.thumb}>
              <Image source={{ uri: img.dataUrl }} style={styles.thumbImage} />
              <Pressable
                onPress={() => removeImage(img.id)}
                accessibilityLabel="Remove image"
                hitSlop={8}
                style={styles.thumbRemove}
              >
                <Text style={styles.thumbRemoveText}>×</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      {readonly ? (
        <View style={styles.readonlyBar}>
          <Text style={styles.readonlyText}>
            Demo trip — clone it from the trips list to chat with Penny.
          </Text>
        </View>
      ) : onboardingBlockingLoad ? (
        <View style={styles.setupLoading}>
          <Spinner />
          <Text style={styles.setupLoadingText}>Loading setup…</Text>
        </View>
      ) : (
        <>
          {onboardingUiActive && onboardingSnapshot?.progress ? (
            <View style={styles.progressWrap}>
              <Text style={styles.progressText}>
                Setup · {onboardingSnapshot.progress.current} of {onboardingSnapshot.progress.total}
              </Text>
            </View>
          ) : null}

          {/* TODO(sam): the server can attach `help` to a question (units_pick,
              range_km — see
              buildVehicleProfileQuestions in src/lib/vehicleProfile.ts), but the
              web ChatPanel declares the field and renders it nowhere, so there is
              no placement to copy. Confirm where it belongs before adding it. */}
          {onboardingUiActive &&
          (onboardingQuestion?.kind === "select" || onboardingQuestion?.kind === "chips") &&
          onboardingQuestion.options ? (
            <View style={styles.optionsWrap}>
              {/* Only for 'select', where tapping is the ONLY way to answer.
                  On a 'chips' step the composer stays live, so telling the
                  user to tap would be wrong. */}
              {onboardingQuestion.kind === "select" ? (
                <Text style={styles.optionsLabel}>Tap an option</Text>
              ) : null}
              <View style={styles.optionsRow}>
                {onboardingQuestion.options.map((o) => (
                  <Pressable
                    key={o.value}
                    disabled={onboardingComposerBusy}
                    onPress={() => void submitOnboardingPick(o.value)}
                    style={[styles.optionChip, onboardingComposerBusy ? styles.optionChipOff : null]}
                  >
                    <Text style={styles.optionChipText}>{o.label}</Text>
                  </Pressable>
                ))}
              </View>
              {onboardingQuestion.footnote ? (
                <Text style={styles.optionsFootnote}>{onboardingQuestion.footnote}</Text>
              ) : null}
            </View>
          ) : null}

          {/*
            PROMPT ROWS. These PREFILL the composer and focus it — they do not
            submit, which is the whole difference between them and the chips
            above. An option is an answer; a prompt is a shape to edit, and
            nobody wants their first message sent verbatim.
          */}
          {onboardingUiActive && onboardingQuestion?.prompts?.length ? (
            <View style={styles.promptsWrap}>
              {onboardingQuestion.prompts.map((prompt) => (
                <Pressable
                  key={prompt}
                  disabled={onboardingComposerBusy}
                  onPress={() => {
                    setInput(prompt);
                    inputRef.current?.focus();
                  }}
                  style={[styles.promptRow, onboardingComposerBusy ? styles.optionChipOff : null]}
                >
                  <Text style={styles.promptText}>{prompt}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          <View testID="chat-composer" style={styles.composerWrap}>
            {onboardingError ? <Text style={styles.composerError}>{onboardingError}</Text> : null}
            <View style={styles.composer}>
              {attachImagesAllowed ? (
                <Pressable
                  onPress={() => void pickImages()}
                  accessibilityLabel="Attach image"
                  style={styles.attachButton}
                >
                  {/* src/components/ChatPanel.tsx:2133-2135 — paperclip, 16px,
                      tinted var(--tp-muted) (:2116). */}
                  <PaperclipIcon color={theme.muted} />
                </Pressable>
              ) : null}
              <TextInput
                testID="chat-composer-input"
                ref={inputRef}
                value={input}
                onChangeText={setInput}
                // The web composer is a <textarea>, so every answer — including
                // the questions the server flags `multiline` (trip_intent,
                // range_help) — is typed into a multiline field. Always-on here
                // is the native equivalent.
                multiline
                editable={!onboardingComposerDisabled && !onboardingSelectStep && !paywalled}
                placeholder={placeholder}
                placeholderTextColor={theme.subtle}
                // Auto-grow: one line (34pt) up to ~8 lines (200pt), after which
                // the field scrolls internally.
                onContentSizeChange={(e) =>
                  setInputHeight(Math.min(Math.max(e.nativeEvent.contentSize.height, 34), 200))
                }
                onFocus={() => {
                  if (onboardingUiActive) return;
                  setTimeout(() => scrollToBottom(), 250);
                }}
                style={[styles.input, { height: inputHeight }]}
              />
              <Pressable
                testID="chat-composer-send"
                onPress={() => void sendMessage()}
                disabled={!sendEnabled}
                accessibilityLabel="Send"
                style={[styles.sendButton, !sendEnabled ? styles.sendButtonOff : null]}
              >
                {/* src/components/ChatPanel.tsx:2246-2249 — up arrow, 16px;
                    var(--tp-on-primary) when armed, var(--tp-subtle) when not
                    (:2222-2231). */}
                <SendArrowIcon color={sendEnabled ? theme.onPrimary : theme.subtle} />
              </Pressable>
            </View>
          </View>
        </>
      )}

      {/* The one modal in this flow, and only when there is something to sell.
          A capped or revoked account never reaches it — that button is a
          mailto. */}
      {purchaseSheetOpen && entitlement && !paywallSupportOnly ? (
        <PurchaseSheet
          flow={purchaseFlow}
          // The sheet has already confirmed entitlement with the server; this
          // brings the transcript's own state in line — the same updates the
          // purchase path makes, and for the same reason.
          onRedeemed={() => {
            void (async () => {
              const fresh = await fetchEntitlement();
              if (fresh) onEntitled(fresh);
            })();
          }}
          onClose={() => setPurchaseSheetOpen(false)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, backgroundColor: theme.surfaceMuted },

  header: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  starterBlock: { paddingBottom: 12, gap: 8 },
  starterKicker: {
    fontSize: 9.5,
    fontFamily: font.semibold,
    letterSpacing: 1.3,
    color: theme.subtle,
  },
  starterHeadline: {
    fontSize: 19,
    fontFamily: font.medium,
    lineHeight: 25,
    color: theme.text,
    marginBottom: 8,
  },
  starterRow: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    borderRadius: theme.radiusMd,
    backgroundColor: theme.surface,
  },
  starterText: { fontFamily: font.regular, fontSize: 13.5, color: theme.muted },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.accent900,
    borderWidth: 1,
    borderColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: theme.accent300, fontFamily: font.semibold, fontSize: 14 },
  headerCopy: { flex: 1, minWidth: 0 },
  headerName: { fontSize: 14, fontFamily: font.medium, color: theme.text },
  headerSub: {
    fontFamily: font.regular,
    fontSize: 11,
    color: theme.subtle,
    letterSpacing: 0.2,
    marginTop: 2,
  },
  headerStatus: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.primary },
  statusDotThinking: { backgroundColor: theme.accent300 },
  statusText: {
    fontSize: 9.5,
    fontFamily: font.semibold,
    letterSpacing: 1.3,
    color: theme.subtle,
  },
  statusTextThinking: { color: theme.accent300 },

  scroll: { flex: 1, minHeight: 0 },
  scrollContent: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  spacer: { flex: 1 },
  historyLoading: { alignItems: "center", paddingVertical: 12 },

  loadOlderRow: { alignItems: "center", paddingTop: 4, paddingBottom: 6 },
  loadOlderLabel: {
    fontFamily: font.regular,
    fontSize: 11,
    color: theme.subtle,
    letterSpacing: 0.7,
    textTransform: "uppercase",
  },
  loadOlderButton: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  loadOlderButtonText: {
    fontFamily: font.regular,
    fontSize: 11,
    color: theme.muted,
    letterSpacing: 0.7,
    textTransform: "uppercase",
  },

  row: { maxWidth: "80%" },
  queued: { opacity: 0.5 },
  bubble: { paddingVertical: 8, paddingHorizontal: 14 },
  bubbleUser: { backgroundColor: theme.primaryMuted },
  bubbleAssistant: { backgroundColor: theme.surface },
  bubbleText: { fontFamily: font.regular, fontSize: 14, color: theme.text, lineHeight: 21 },
  bubbleImages: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  bubbleImagesGap: { marginBottom: 8 },
  bubbleImage: { width: 160, height: 160, borderRadius: 6, resizeMode: "cover" },

  appliedNote: {
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: theme.successMuted,
    borderRadius: 4,
    borderWidth: 1,
    // src/components/ChatPanel.tsx:1763
    borderColor: "rgba(74, 139, 122, 0.28)",
  },
  appliedNoteText: { fontFamily: font.regular, fontSize: 11, color: theme.success },
  partialNote: {
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    // src/components/ChatPanel.tsx:1780
    backgroundColor: "rgba(212, 160, 23, 0.12)",
    borderRadius: 4,
    borderWidth: 1,
    // src/components/ChatPanel.tsx:1782
    borderColor: "rgba(212, 160, 23, 0.35)",
  },
  partialNoteText: { fontFamily: font.regular, fontSize: 11, color: theme.text, lineHeight: 16 },
  errorNote: {
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: theme.dangerMuted,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "rgba(198, 93, 74, 0.35)",
  },
  errorNoteText: { fontFamily: font.regular, fontSize: 11, color: theme.danger, lineHeight: 16 },

  /* Paragraph gap for the paywall's written (not streamed) copy. */
  paywallParagraph: { marginTop: 10 },
  paywallButton: {
    alignSelf: "flex-start",
    marginTop: 10,
    paddingVertical: 7,
    paddingHorizontal: 14,
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
  },
  /* usage_cap / revoked: an apology, not a sale. Quieter than the buy button
     for the same reason the web renders that one as a link. */
  paywallButtonQuiet: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: theme.borderStrong,
  },
  paywallButtonText: {
    fontSize: 12,
    fontFamily: font.semibold,
    color: theme.onPrimary,
    letterSpacing: 0.2,
  },
  paywallButtonTextQuiet: { color: theme.primary },

  truncatedCard: {
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: theme.dangerMuted,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "rgba(198, 93, 74, 0.35)",
    gap: 6,
  },
  truncatedTitle: { fontSize: 12, color: theme.danger, fontFamily: font.semibold },
  truncatedBody: { fontFamily: font.regular, fontSize: 12, color: theme.muted, lineHeight: 17 },
  continueButton: {
    alignSelf: "flex-start",
    marginTop: 2,
    paddingVertical: 5,
    paddingHorizontal: 10,
    backgroundColor: theme.primary,
    borderRadius: 6,
  },
  continueButtonOff: { backgroundColor: theme.border },
  continueButtonText: {
    fontSize: 11,
    fontFamily: font.semibold,
    color: theme.onPrimary,
    letterSpacing: 0.4,
  },
  continueButtonTextOff: { color: theme.subtle },

  receipt: { fontFamily: font.regular, fontSize: 11, color: theme.muted, marginTop: 2, alignSelf: "flex-end" },
  receiptRead: { color: theme.primary },

  thumbRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 6,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.border,
  },
  thumbImage: { width: "100%", height: "100%", resizeMode: "cover" },
  thumbRemove: {
    position: "absolute",
    top: 2,
    right: 2,
    width: 18,
    height: 18,
    borderRadius: 9,
    // src/components/ChatPanel.tsx:1948 — background: var(--tp-overlay)
    backgroundColor: theme.overlay,
    alignItems: "center",
    justifyContent: "center",
  },
  thumbRemoveText: { fontFamily: font.regular, color: theme.onPrimary, fontSize: 12, lineHeight: 14 },

  /*
   * paddingBottom is a flat 12 — this component never owns the bottom safe
   * area. Its host does: BottomNav sits below it and already pads
   * `insets.bottom`, so adding it here too counted the home indicator twice
   * and left the visible gap between the composer and the nav. When the
   * keyboard is up the nav unmounts, but the keyboard covers the home
   * indicator itself, so 12 is still right. Both states, one number.
   */
  readonlyBar: {
    paddingTop: 12,
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: theme.border,
  },
  readonlyText: { fontFamily: font.regular, color: theme.muted, fontSize: 12, textAlign: "center" },

  /*
   * paddingBottom is a flat 12 — this component never owns the bottom safe
   * area. Its host does: BottomNav sits below it and already pads
   * `insets.bottom`, so adding it here too counted the home indicator twice
   * and left the visible gap between the composer and the nav. When the
   * keyboard is up the nav unmounts, but the keyboard covers the home
   * indicator itself, so 12 is still right. Both states, one number.
   */
  setupLoading: {
    paddingTop: 12,
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    backgroundColor: theme.surfaceMuted,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  setupLoadingText: { fontFamily: font.regular, color: theme.muted, fontSize: 13 },

  progressWrap: { paddingTop: 8, paddingHorizontal: 16, backgroundColor: theme.surfaceMuted },
  progressText: {
    fontSize: 11,
    fontFamily: font.semibold,
    color: theme.primary,
    letterSpacing: 0.7,
    textTransform: "uppercase",
  },

  optionsWrap: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    backgroundColor: theme.surfaceMuted,
  },
  optionsLabel: { fontFamily: font.regular, fontSize: 11, color: theme.muted, marginBottom: 6, letterSpacing: 0.3 },
  optionsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  optionsFootnote: {
    fontFamily: font.regular,
    fontSize: 11,
    color: theme.subtle,
    lineHeight: 16,
    marginTop: 8,
  },
  promptsWrap: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    backgroundColor: theme.surfaceMuted,
    gap: 8,
  },
  promptRow: {
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    borderRadius: theme.radiusMd,
    backgroundColor: theme.surface,
  },
  promptText: { fontFamily: font.regular, fontSize: 13.5, color: theme.muted },
  optionChip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 999,
  },
  optionChipOff: { opacity: 0.5 },
  optionChipText: { fontFamily: font.regular, color: theme.text, fontSize: 13 },

  /*
   * paddingBottom is a flat 12 — this component never owns the bottom safe
   * area. Its host does: BottomNav sits below it and already pads
   * `insets.bottom`, so adding it here too counted the home indicator twice
   * and left the visible gap between the composer and the nav. When the
   * keyboard is up the nav unmounts, but the keyboard covers the home
   * indicator itself, so 12 is still right. Both states, one number.
   */
  composerWrap: {
    paddingTop: 12,
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    backgroundColor: theme.surfaceMuted,
  },
  composerError: { fontFamily: font.regular, fontSize: 12, color: theme.danger, marginBottom: 8 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 20,
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  attachButton: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    fontFamily: font.regular,
    flex: 1,
    minWidth: 0,
    paddingVertical: 7,
    paddingHorizontal: 4,
    color: theme.text,
    fontSize: 14,
    lineHeight: 20,
    textAlignVertical: "top",
  },
  sendButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonOff: { backgroundColor: theme.border },
});
