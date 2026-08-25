import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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

interface ChatPanelProps {
  tripId: string;
  /** When not 'done', the composer submits onboarding answers until handoff. */
  onboardingState: OnboardingState;
  readonly: boolean;
  onTripUpdated: () => void;
  onActivity: (kind: "thinking" | "response" | "error") => void;
}

export default function ChatPanel({
  tripId,
  onboardingState,
  readonly,
  onTripUpdated,
  onActivity,
}: ChatPanelProps) {
  const { units } = useUnits();
  const { notify } = useErrors();
  const insets = useSafeAreaInsets();
  const api = useMemo(() => tripApi(tripId), [tripId]);

  const isOnboarding = onboardingState !== "done" && !readonly;

  const [messages, setMessages] = useState<UIMessage[]>([]);
  // Latest messages, readable from listeners (the AppState reconcile) without
  // re-binding them on every message change.
  const messagesRef = useRef<UIMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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
        // Pre-stream errors (rate limit, validation, missing key).
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
    if (q.kind === "text") {
      if (!trimmed) {
        setOnboardingError("This one is required.");
        return;
      }
      await submitOnboardingAnswer(q.key, trimmed);
      return;
    }
    if (q.kind === "number" || q.kind === "integer") {
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
    !onboardingComposerBusy &&
    ((!onboardingUiActive && (hasComposerText || images.length > 0)) ||
      (onboardingUiActive && !!onboardingQuestion && !onboardingSelectStep && hasComposerText));

  const placeholder = onboardingSelectStep
    ? "Tap an option above…"
    : onboardingUiActive && onboardingQuestion
      ? (onboardingQuestion.placeholder ?? "Type your answer…")
      : "Ask Penny…";

  return (
    <KeyboardAvoidingView
      style={styles.root}
      // iOS floats the keyboard over the app, so the composer needs padding
      // pushed under it; Android's adjustResize already shrinks the window.
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Header */}
      <View style={styles.header}>
        {/* The web paints this circle with a primary→success linear-gradient;
            no gradient without another native dep, so it's flat primary. */}
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>P</Text>
        </View>
        <View style={styles.headerCopy}>
          <Text style={styles.headerName}>Penny</Text>
          <Text style={styles.headerSub}>Feral Travels AI</Text>
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

        {messages.map((msg, msgIdx) => {
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
            !msg.truncated
          ) {
            return null;
          }

          const gp = getGroupPosition(messages, msgIdx);
          // Tight 2pt gap inside a group, 10pt between groups.
          const marginTop = msgIdx === 0 ? 0 : gp.isFirst ? 10 : 2;
          const isUser = msg.role === "user";
          const isQueued = msg.deliveryStatus === "queued";
          const isLastUserMessage =
            isUser && !messages.slice(msgIdx + 1).some((m) => m.role === "user");

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

                {msg.content ? (
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
        <View style={[styles.readonlyBar, { paddingBottom: 12 + insets.bottom }]}>
          <Text style={styles.readonlyText}>
            Demo trip — clone it from the trips list to chat with Penny.
          </Text>
        </View>
      ) : onboardingBlockingLoad ? (
        <View style={[styles.setupLoading, { paddingBottom: 12 + insets.bottom }]}>
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
          {onboardingUiActive && onboardingQuestion?.kind === "select" && onboardingQuestion.options ? (
            <View style={styles.optionsWrap}>
              <Text style={styles.optionsLabel}>Tap an option</Text>
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
            </View>
          ) : null}

          <View style={[styles.composerWrap, { paddingBottom: 12 + insets.bottom }]}>
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
                ref={inputRef}
                value={input}
                onChangeText={setInput}
                // The web composer is a <textarea>, so every answer — including
                // the questions the server flags `multiline` (trip_intent,
                // range_help) — is typed into a multiline field. Always-on here
                // is the native equivalent.
                multiline
                editable={!onboardingComposerDisabled && !onboardingSelectStep}
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
    </KeyboardAvoidingView>
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
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: theme.onPrimary, fontFamily: font.extrabold, fontSize: 13 },
  headerCopy: { minWidth: 0 },
  headerName: { fontSize: 14, fontFamily: font.bold, color: theme.text },
  headerSub: { fontFamily: font.regular, fontSize: 10, color: theme.subtle, letterSpacing: 0.4, marginTop: 2 },

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

  readonlyBar: {
    paddingTop: 12,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: theme.border,
  },
  readonlyText: { fontFamily: font.regular, color: theme.muted, fontSize: 12, textAlign: "center" },

  setupLoading: {
    paddingTop: 12,
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

  composerWrap: {
    paddingTop: 12,
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
