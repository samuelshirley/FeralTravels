'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { ChatMessage, OnboardingState } from '@/types/trip';
import { tripApi, apiFetch } from '@/lib/api';
import Spinner from '@/components/Spinner';

interface ChatPanelProps {
  tripId: string;
  initialMessages: ChatMessage[];
  initialHasMore?: boolean;
  /**
   * When not 'done', the normal composer submits answers to
   * `/api/trips/:id/onboarding` until handoff, then Penny streams as usual.
   */
  onboardingState?: OnboardingState;
  /** When true, show vehicle remediation questions before normal chat. */
  needsVehicleRemediation?: boolean;
  onTripUpdated: () => void;
  onActivity?: (event: 'thinking' | 'response' | 'error' | 'fuel-planning') => void;
  readonly?: boolean;
}

interface AttachedImage {
  id: string;
  dataUrl: string;
  mediaType: string;
  name: string;
}

interface InFlightTool {
  /** Per-tool-call id from the model so we can update the same pill on tool_done. */
  toolUseId: string;
  /** Human label, e.g. "Looking up routes". */
  label: string;
  /** Lifecycle: 'running' shows spinner, 'ok'/'error' fades the pill. */
  status: 'running' | 'ok' | 'error';
}

/** Mirrors `/api/me/vehicle-remediation` snapshot — keep aligned with server route. */
interface VehicleRemediationSnapshot {
  needs_remediation: boolean;
  done: boolean;
  active_vehicle: { id: string; name: string } | null;
  question: {
    key: string;
    kind: 'text' | 'number' | 'integer' | 'select' | 'handoff';
    label: string;
    placeholder?: string;
    help?: string;
    options?: Array<{ value: string; label: string }>;
    optional?: boolean;
    min?: number;
    max?: number;
    multiline?: boolean;
  } | null;
  progress: { current: number; total: number } | null;
  garage_empty?: boolean;
}

/** GET `/api/trips/:id/onboarding` — shape matches server snapshot. */
interface OnboardingSnapshot {
  state: OnboardingState;
  question: VehicleRemediationSnapshot['question'];
  vehicles: Array<{ id: string; name: string; is_default: boolean }>;
  progress: { current: number; total: number } | null;
}

interface OnboardingAnswerResult {
  next: OnboardingSnapshot;
  answerLabel: string;
  didHandoff: boolean;
  /** The stored trip intent to send to Penny when onboarding is done. */
  tripIntent?: string;
}

/**
 * Message delivery lifecycle — mirrors iMessage/WhatsApp status indicators.
 * Each state maps to a real server-side event:
 *   queued     → user sent while Penny was thinking; will fire when Penny finishes
 *   sending    → fetch() fired, waiting for server acknowledgement
 *   delivered  → server persisted the user message (SSE `received` event)
 *   read       → Penny is building context / about to call Claude (SSE `reading` event)
 *   typing     → first text chunk or tool event arrived (Penny is actively responding)
 *   responded  → Penny's full response is complete (SSE `applied` event)
 */
type DeliveryStatus = 'queued' | 'sending' | 'delivered' | 'read' | 'typing' | 'responded';

interface UIMessage extends Omit<ChatMessage, 'seq'> {
  /** Sequential ordering number — 0 or absent for optimistic (unsaved) messages. */
  seq?: number;
  imageDataUrls?: string[];
  // Populated when Penny proposed changes but the server couldn't apply them
  // (unknown action, owner mismatch, DB error). We surface this so the user
  // doesn't see a misleading "Changes applied to trip" badge.
  applyError?: string | null;
  /** When some writes succeeded AND some failed — show success + this warning */
  partialApplyWarning?: string | null;
  /** Server-generated deterministic route summary from actual DB leg state. */
  routeSummary?: string | null;
  // True when the replan response had truncated=true — i.e. Penny hit the
  // tool-use iteration cap mid-plan and only persisted partial work. We
  // surface a warning + 'Continue planning' button on the bubble. UI-only;
  // not persisted, so historical messages from a page reload never show it.
  truncated?: boolean;
  // Live status pills while Penny is streaming. Set on the in-progress
  // assistant message bubble; cleared once the stream's `applied` event
  // arrives. Persisted messages from page reload never have these.
  inFlightTools?: InFlightTool[];
  /** True while the SSE stream is still appending paragraphs. */
  streaming?: boolean;
  /** Delivery lifecycle for user messages (sending → delivered → read → typing → responded). */
  deliveryStatus?: DeliveryStatus;
}

/**
 * Map Penny's internal tool names → the short human label we show as a
 * status pill on the assistant bubble while the tool runs. Anything we
 * forget falls back to the verbatim tool name (visibly ugly, which is
 * the point — it surfaces missing labels for follow-up tweaks).
 */
const PENNY_TOOL_LABELS: Record<string, string> = {
  rename_trip: 'Naming your trip',
  extract_trip_intent: 'Reading your request',
  get_route: 'Looking up routes',
  check_trip_feasibility: 'Checking feasibility',
  update_vehicle: 'Saving preferences',
  add_leg: 'Saving plan',
  update_leg: 'Saving plan',
  delete_leg: 'Saving plan',
  add_stop: 'Saving stops',
  update_stop: 'Saving stops',
  delete_stop: 'Saving stops',
  plan_fuel_stops: 'Planning fuel',
  plan_dump_station_stops: 'Finding dump stations',
  add_route: 'Saving routes',
  update_route: 'Saving routes',
  delete_route: 'Saving routes',
  add_task: 'Saving tasks',
  update_task: 'Saving tasks',
};

function pennyToolLabel(name: string): string {
  return PENNY_TOOL_LABELS[name] ?? name;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/* ── iMessage-style grouping ─────────────────────────────────────────────
 * Consecutive messages from the same role are visually grouped: tighter
 * spacing, varied corner radii, and a tail on the last bubble only.
 * This mirrors iMessage's grouping behaviour. */
interface GroupPosition {
  isFirst: boolean;
  isLast: boolean;
}

function getGroupPosition(
  messages: { role: string }[],
  index: number,
): GroupPosition {
  const msg = messages[index];
  const prev = index > 0 ? messages[index - 1] : null;
  const next = index < messages.length - 1 ? messages[index + 1] : null;
  return {
    isFirst: !prev || prev.role !== msg.role,
    isLast: !next || next.role !== msg.role,
  };
}

/** Returns the iMessage-style border-radius string for a bubble. */
function bubbleRadius(role: string, pos: GroupPosition): string {
  const R = 18; // full radius
  const r = 4;  // grouped-side radius
  if (role === 'user') {
    // Right side grouped: top-right and bottom-right shrink for non-edge
    const tr = pos.isFirst ? R : r;
    const br = pos.isLast ? R : r;
    return `${R}px ${tr}px ${br}px ${R}px`;
  }
  // Assistant: left side grouped
  const tl = pos.isFirst ? R : r;
  const bl = pos.isLast ? R : r;
  return `${tl}px ${R}px ${R}px ${bl}px`;
}

export default function ChatPanel({
  tripId,
  initialMessages,
  initialHasMore = false,
  onboardingState = 'done',
  needsVehicleRemediation = false,
  onTripUpdated,
  onActivity,
  readonly = false,
}: ChatPanelProps) {
  const isOnboarding = onboardingState !== 'done' && !readonly;
  const [onboardingSnapshot, setOnboardingSnapshot] = useState<OnboardingSnapshot | null>(null);
  const [onboardingLoading, setOnboardingLoading] = useState(isOnboarding);
  const [onboardingSubmitting, setOnboardingSubmitting] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const onboardingUiActive =
    isOnboarding &&
    onboardingSnapshot !== null &&
    onboardingSnapshot.state !== 'done';
  const onboardingBlockingLoad = isOnboarding && onboardingLoading && !onboardingSnapshot;
  const onboardingQuestion = onboardingUiActive ? onboardingSnapshot.question : null;
  const onboardingSelectStep =
    onboardingUiActive &&
    onboardingQuestion &&
    onboardingQuestion.kind === 'select';
  const [remediationDone, setRemediationDone] = useState(false);
  const showRemediation = needsVehicleRemediation && !remediationDone && !isOnboarding && !readonly;
  const attachImagesAllowed = !showRemediation && !isOnboarding;
  const [remSnapshot, setRemSnapshot] = useState<VehicleRemediationSnapshot | null>(null);
  const [remLoading, setRemLoading] = useState(false);
  const [remSubmitting, setRemSubmitting] = useState(false);
  const [remError, setRemError] = useState<string | null>(null);
  const remGarageEmptyWarned = useRef(false);
  const [messages, setMessages] = useState<UIMessage[]>(initialMessages);
  const [input, setInput] = useState('');
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [loading, setLoading] = useState(false);
  /** True while Penny's intro typing animation plays (first visit only). */
  const [introTyping, setIntroTyping] = useState(false);
  /** Queue of messages sent while Penny is thinking — drained one-at-a-time. */
  const messageQueueRef = useRef<Array<{ text: string; images: AttachedImage[]; msgId: string }>>([]);
  const [dragOver, setDragOver] = useState(false);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const didInitialScroll = useRef(false);
  const pendingRestoreScroll = useRef<{ prevHeight: number } | null>(null);

  // Jump to the bottom on first render (so the last message is visible) and
  // smooth-scroll on every subsequent new message or loading toggle. We use
  // scrollTop instead of scrollIntoView because on iOS Safari, scrollIntoView
  // can trigger viewport-level scrolling that dismisses the keyboard mid-send.
  const scrollToBottom = useCallback((instant?: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    if (instant) {
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, []);

  useEffect(() => {
    if (!didInitialScroll.current) {
      scrollToBottom(true);
      didInitialScroll.current = true;
      return;
    }
    scrollToBottom();
  }, [messages.length, loading, scrollToBottom]);

  // Listen for "Add to this day" button clicks from rest-day LegCards.
  // Pre-fills the chat input with a contextual prompt for Penny.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        legId: string;
        dayTitle: string;
        location: string;
        dates: string | null;
      };
      const locationStr = detail.location || 'this location';
      const prompt = `I want to add plans for ${detail.dayTitle} in ${locationStr} — what should I do there?`;
      setInput(prompt);
      textareaRef.current?.focus();
      scrollToBottom();
    };
    window.addEventListener('penny:prefill', handler);
    return () => window.removeEventListener('penny:prefill', handler);
  }, [scrollToBottom]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMore || messages.length === 0) return;
    // Optimistic messages have no `seq` (or seq=0). Walk from the front to
    // find the earliest persisted message with a real seq — that's our cursor.
    const earliest = messages.find((m) => (m.seq ?? 0) > 0);
    if (!earliest) return;
    setLoadingOlder(true);
    const scrollEl = scrollRef.current;
    pendingRestoreScroll.current = scrollEl
      ? { prevHeight: scrollEl.scrollHeight }
      : null;
    try {
      const data = await apiFetch<{ messages: ChatMessage[]; hasMore: boolean }>(
        `/api/chat`,
        { query: { tripId, beforeSeq: earliest.seq } }
      );
      setMessages((prev) => [...data.messages, ...prev]);
      setHasMore(data.hasMore);
    } catch (e) {
      console.warn('Failed to load older chat:', e);
    } finally {
      setLoadingOlder(false);
    }
  }, [hasMore, loadingOlder, messages, tripId]);

  // Restore scroll position after prepending older messages so the viewport
  // stays anchored to where the user was reading.
  useEffect(() => {
    const el = scrollRef.current;
    const restore = pendingRestoreScroll.current;
    if (!el || !restore) return;
    const diff = el.scrollHeight - restore.prevHeight;
    el.scrollTop = diff;
    pendingRestoreScroll.current = null;
  }, [messages]);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      // ~40px threshold feels natural on both trackpads and touch.
      if (el.scrollTop < 40 && hasMore && !loadingOlder) loadOlder();
    },
    [hasMore, loadingOlder, loadOlder]
  );

  // Auto-grow textarea (single-line by default, max ~8 lines).
  //
  // Guard against hidden-pane collapse: on mobile, the chat pane uses
  // `display: none` when another tab is active. A `display:none` subtree
  // has `scrollHeight === 0`, so without this guard we'd write
  // `height: 0px` and — when the user switches to the chat tab — the
  // textarea would still be a 2-pixel sliver with its placeholder clipping
  // through (the "static pixels at the bottom" bug). The inline
  // `minHeight` on the textarea itself is a second line of defense so the
  // input is always at least one line tall even if this effect never ran
  // while visible.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    if (ta.scrollHeight <= 0) return;
    const next = Math.min(ta.scrollHeight, 200);
    ta.style.height = next + 'px';
  }, [input]);

  // Re-focus the textarea after an onboarding/remediation submission completes
  // so the mobile keyboard stays open for continuous back-and-forth chat.
  // We track "was submitting" → "no longer submitting" transitions.
  const wasOnboardingSubmitting = useRef(false);
  const wasRemSubmitting = useRef(false);

  useEffect(() => {
    if (onboardingSubmitting) {
      wasOnboardingSubmitting.current = true;
    } else if (wasOnboardingSubmitting.current) {
      wasOnboardingSubmitting.current = false;
      // Small delay lets React finish the re-render (new question rendered)
      // before we grab focus. requestAnimationFrame is enough on iOS.
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [onboardingSubmitting]);

  useEffect(() => {
    if (remSubmitting) {
      wasRemSubmitting.current = true;
    } else if (wasRemSubmitting.current) {
      wasRemSubmitting.current = false;
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [remSubmitting]);

  useEffect(() => {
    remGarageEmptyWarned.current = false;
  }, [tripId]);

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
        const data = await apiFetch<OnboardingSnapshot>(`/api/trips/${tripId}/onboarding`);
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
  }, [isOnboarding, tripId]);

  useEffect(() => {
    if (!showRemediation) return;
    let cancelled = false;
    setRemLoading(true);
    void (async () => {
      try {
        const data = await apiFetch<VehicleRemediationSnapshot>('/api/me/vehicle-remediation');
        if (cancelled) return;
        setRemSnapshot(data);
        setRemError(null);
        if (data.done || !data.needs_remediation) {
          setRemediationDone(true);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setRemError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setRemLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showRemediation]);

  useEffect(() => {
    if (!showRemediation || remLoading) return;
    if (remSnapshot?.garage_empty) {
      if (remGarageEmptyWarned.current) return;
      remGarageEmptyWarned.current = true;
      setMessages((prev) => [
        ...prev,
        {
          id: `optimistic-${Date.now()}`,
          trip_id: tripId,
          role: 'assistant' as const,
          content:
            'You need a vehicle on your account before we can plan fuel stops. Add one in Settings, then come back here.',
          kind: 'ai' as const,
          changes_made: null,
          created_at: new Date().toISOString(),
        },
      ]);
      return;
    }
    const q = remSnapshot?.question;
    if (!q) return;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === 'form_question' && last.content === q.label) return prev;
      return [
        ...prev,
        {
          id: `optimistic-${Date.now()}`,
          trip_id: tripId,
          role: 'assistant' as const,
          content: q.label,
          kind: 'form_question' as const,
          changes_made: null,
          created_at: new Date().toISOString(),
        },
      ];
    });
  }, [showRemediation, remLoading, remSnapshot, tripId]);

  useEffect(() => {
    if (!isOnboarding || onboardingLoading || !onboardingSnapshot || onboardingSnapshot.state === 'done') {
      return;
    }
    const q = onboardingSnapshot.question;
    if (!q) return;

    const addQuestionBubble = () => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.kind === 'form_question' && last.content === q.label) return prev;
        return [
          ...prev,
          {
            id: `optimistic-${Date.now()}`,
            trip_id: tripId,
            role: 'assistant' as const,
            content: q.label,
            kind: 'form_question' as const,
            changes_made: null,
            created_at: new Date().toISOString(),
          },
        ];
      });
    };

    // Show typing indicator before each onboarding question so the flow
    // feels like a real conversation. First question gets 3s (the greeting
    // is longer), subsequent questions get 2s.
    const isFirstQuestion = onboardingSnapshot.state === 'trip_intent' && messages.length === 0;
    const delay = isFirstQuestion ? 3000 : 2000;

    setIntroTyping(true);
    const timer = setTimeout(() => {
      setIntroTyping(false);
      addQuestionBubble();
    }, delay);
    return () => clearTimeout(timer);
  }, [isOnboarding, onboardingLoading, onboardingSnapshot, tripId]); // eslint-disable-line react-hooks/exhaustive-deps

  function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function addImageFiles(files: FileList | File[]) {
    const arr = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (arr.length === 0) return;
    const next: AttachedImage[] = [];
    for (const f of arr) {
      if (f.size > MAX_IMAGE_BYTES) {
        console.warn(`Skipping ${f.name}: > 8 MB`);
        continue;
      }
      const dataUrl = await fileToDataUrl(f);
      next.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        dataUrl,
        mediaType: f.type,
        name: f.name || 'screenshot',
      });
    }
    if (next.length) setImages((prev) => [...prev, ...next]);
  }

  function removeImage(id: string) {
    setImages((prev) => prev.filter((i) => i.id !== id));
  }

  // Shared inner engine for "user said X → Penny replies". `sendMessage`
  // is the free-text composer path (pulls from input/images state); the
  // onboarding handoff calls `sendChatMessage` directly with the first
  // real user message right after the onboarding form finishes.
  //
  // Streams the response as Server-Sent Events so the user sees Penny's
  // paragraphs + "Looking up routes…" / "Checking feasibility…" status
  // pills land live instead of waiting for the entire turn to buffer.
  // The terminal `applied` event carries the same shape as the old JSON
  // response — that's where we trigger onTripUpdated and the optional
  // fuel replenish.
  const sendChatMessage = async (
    trimmed: string,
    attachedImages: AttachedImage[] = [],
    /** When draining the queue, pass the existing optimistic message id to reuse it. */
    existingUserMsgId?: string,
  ): Promise<void> => {
    if (!trimmed && attachedImages.length === 0) return;

    const userMsgId = existingUserMsgId ?? `optimistic-${Date.now()}`;
    const assistantMsgId = `optimistic-${Date.now() + 1}`;

    if (existingUserMsgId) {
      // Reuse the existing queued user bubble — just update its status and
      // append the pending assistant bubble after it.
      setMessages((prev) => {
        const updated = prev.map((m) =>
          m.id === existingUserMsgId ? { ...m, deliveryStatus: 'sending' as DeliveryStatus } : m
        );
        return [
          ...updated,
          {
            id: assistantMsgId,
            trip_id: tripId,
            role: 'assistant' as const,
            content: '',
            kind: 'ai' as const,
            changes_made: null,
            created_at: new Date().toISOString(),
            streaming: true,
            inFlightTools: [],
          },
        ];
      });
    } else {
      const tempUserMsg: UIMessage = {
        id: userMsgId,
        trip_id: tripId,
        role: 'user',
        content: trimmed,
        kind: 'ai',
        changes_made: null,
        created_at: new Date().toISOString(),
        imageDataUrls: attachedImages.map((i) => i.dataUrl),
        deliveryStatus: 'sending',
      };
      const pendingAssistantMsg: UIMessage = {
        id: assistantMsgId,
        trip_id: tripId,
        role: 'assistant',
        content: '',
        kind: 'ai',
        changes_made: null,
        created_at: new Date().toISOString(),
        streaming: true,
        inFlightTools: [],
      };
      setMessages((prev) => [...prev, tempUserMsg, pendingAssistantMsg]);
    }
    setLoading(true);
    onActivity?.('thinking');

    /** Append a chunk of streamed text to the in-progress assistant bubble. */
    const appendText = (chunk: string) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                // Insert a blank line between paragraphs so the iteration
                // boundaries read as natural breaks instead of running on.
                content: m.content ? `${m.content}\n\n${chunk}` : chunk,
              }
            : m
        )
      );
    };

    /** Push or update a pill in inFlightTools. */
    const upsertTool = (toolUseId: string, patch: Partial<InFlightTool>) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantMsgId) return m;
          const existing = m.inFlightTools ?? [];
          const idx = existing.findIndex((t) => t.toolUseId === toolUseId);
          if (idx === -1) {
            return {
              ...m,
              inFlightTools: [
                ...existing,
                {
                  toolUseId,
                  label: patch.label ?? '',
                  status: patch.status ?? 'running',
                },
              ],
            };
          }
          const next = existing.slice();
          next[idx] = { ...next[idx], ...patch };
          return { ...m, inFlightTools: next };
        })
      );
    };

    /** Update the delivery status on the most recent user message. */
    const setDeliveryStatus = (status: DeliveryStatus) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === userMsgId ? { ...m, deliveryStatus: status } : m
        )
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
                inFlightTools: undefined,
                applyError: m.content ? msg : null,
              }
            : m
        )
      );
    };

    type AppliedEvent = {
      response: string;
      changes: { changes: unknown[] };
      appliedCount: number;
      failedCount: number;
      failedActions: Array<{ action: string; error: string }>;
      /** DB / feasibility failures — use for user-visible save warnings (SSE from replan). */
      persistFailedCount?: number;
      persistFailedActions?: Array<{ action: string; error: string }>;
      /** Exhausted validation retries; not indicative of unsuccessful writes. */
      validationFailures?: Array<{ action: string; error: string }>;
      /** Validated tool actions queued this turn — may exceed `changes.changes` when saves failed or were gated. */
      validatedQueuedCount?: number;
      fuelReplenishQueued: boolean;
      /** Server-generated deterministic route summary from actual DB leg state. */
      routeSummary?: string | null;
      truncated: boolean;
    };
    let appliedEvent: AppliedEvent | null = null;

    try {
      const res = await fetch('/api/trip/replan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tripId,
          message: trimmed,
          images: attachedImages.map((i) => ({
            dataUrl: i.dataUrl,
            mediaType: i.mediaType,
          })),
        }),
      });

      if (!res.ok) {
        // Pre-stream errors (rate limit, validation, missing key) come back
        // as plain JSON like before.
        const data = await res.json().catch(() => ({}));
        const errMsg = (data as { error?: string }).error ?? `Request failed (${res.status})`;
        setDeliveryStatus('responded');
        failAssistant(`Error: ${errMsg}`);
        onActivity?.('error');
        return;
      }
      if (!res.body) {
        setDeliveryStatus('responded');
        failAssistant('Stream not supported by this browser.');
        onActivity?.('error');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      // SSE frame parsing: events are separated by a blank line. Each event
      // we receive is `data: <json>\n\n` (we don't use multi-line data:
      // continuations). Anything else (`event:`, `id:`, comments) is
      // ignored — we only care about data frames.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const json = line.slice(6);
            let ev: { kind: string; [k: string]: unknown };
            try {
              ev = JSON.parse(json);
            } catch {
              continue;
            }
            switch (ev.kind) {
              case 'received':
                // Server persisted the user message — "Delivered"
                setDeliveryStatus('delivered');
                break;
              case 'reading':
                // Penny is building context / about to call Claude — "Read"
                setDeliveryStatus('read');
                break;
              case 'iteration_start':
                // No UI change — the next text/tool event drives the bubble.
                break;
              case 'text': {
                const chunk = typeof ev.chunk === 'string' ? ev.chunk : '';
                if (chunk) {
                  setDeliveryStatus('typing');
                  appendText(chunk);
                }
                break;
              }
              case 'tool_started': {
                setDeliveryStatus('typing');
                const name = typeof ev.name === 'string' ? ev.name : 'tool';
                const id = typeof ev.toolUseId === 'string' ? ev.toolUseId : `${Date.now()}-${Math.random()}`;
                upsertTool(id, { label: pennyToolLabel(name), status: 'running' });
                break;
              }
              case 'tool_done': {
                const id = typeof ev.toolUseId === 'string' ? ev.toolUseId : '';
                if (!id) break;
                upsertTool(id, { status: ev.ok ? 'ok' : 'error' });
                break;
              }
              case 'applied': {
                appliedEvent = ev as unknown as AppliedEvent;
                break;
              }
              case 'error': {
                const raw = typeof ev.message === 'string' ? ev.message : '';
                // Strip noisy stack traces / internal paths — keep the first sentence
                const cleaned = raw.split('\n')[0]?.slice(0, 200) || '';
                const msg = cleaned
                  ? `Error: ${cleaned}`
                  : 'Something went wrong while updating your trip.';
                failAssistant(msg);
                break;
              }
            }
          }
        }
      }

      if (!appliedEvent) {
        // Stream ended without a terminal `applied` event — treat as failure
        // but preserve whatever partial paragraphs already landed.
        failAssistant(
          'Connection dropped before Penny finished. Your partial response is above; please retry.'
        );
        onActivity?.('error');
        return;
      }

      const {
        response: finalResponse,
        changes,
        appliedCount,
        failedCount,
        failedActions,
        persistFailedCount: persistFailedCountRaw,
        persistFailedActions: persistFailedActionsRaw,
        validatedQueuedCount: validatedQueuedCountRaw,
        validationFailures: validationFailuresRaw,
        fuelReplenishQueued,
        routeSummary: routeSummaryRaw,
        truncated,
      } = appliedEvent;
      const persistFieldsPresent =
        typeof persistFailedCountRaw === 'number' || Array.isArray(persistFailedActionsRaw);

      /** Legacy replan responses omitted persist* — preserve old behavior for those payloads only. */
      const persistFailedActions = persistFieldsPresent
        ? Array.isArray(persistFailedActionsRaw)
          ? persistFailedActionsRaw
          : []
        : Array.isArray(failedActions)
          ? failedActions
          : [];

      const persistFailedCount = persistFieldsPresent
        ? typeof persistFailedCountRaw === 'number'
          ? persistFailedCountRaw
          : persistFailedActions.length
        : failedCount;

      const changeLen = Array.isArray(changes?.changes) ? changes.changes.length : 0;
      /** Number of Penny actions validated and queued for dispatch (may be 0 while validationFailures are non-empty). */
      const hadProposedChanges =
        changeLen > 0 ||
        (typeof validatedQueuedCountRaw === 'number' && validatedQueuedCountRaw > 0);
      let applyError: string | null = null;
      let partialApplyWarning: string | null = null;
      if (persistFailedCount > 0 && appliedCount > 0) {
        partialApplyWarning = `Some edits didn't save: ${persistFailedActions.map((f) => f.action).join(', ')}`;
      } else if (persistFailedCount > 0) {
        const details = persistFailedActions.map((f) => `${f.action}: ${f.error}`).join('; ');
        applyError = `Changes failed to save — ${details}`;
      } else if (hadProposedChanges && appliedCount === 0) {
        // Include validation failure details if present
        const valFailures = Array.isArray(validationFailuresRaw) ? validationFailuresRaw : [];
        const valDetails = valFailures.length > 0
          ? ` (${valFailures.map((v: { action: string; error: string }) => `${v.action}: ${v.error.slice(0, 80)}`).join('; ')})`
          : '';
        applyError =
          `Penny proposed changes but nothing was saved${valDetails}. Re-ask her with more detail (e.g. starting point, destination).`;
      }

      setDeliveryStatus('responded');
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                // Authoritative final text from the server (the streamed
                // chunks were the same content joined with double-newlines —
                // this overwrite keeps us consistent with what's persisted
                // server-side via addChatMessage).
                content: finalResponse || m.content,
                changes_made:
                  appliedCount > 0 ? JSON.stringify(changes ?? { changes: [] }) : null,
                applyError,
                partialApplyWarning,
                routeSummary: typeof routeSummaryRaw === 'string' ? routeSummaryRaw : null,
                truncated,
                streaming: false,
                inFlightTools: undefined,
              }
            : m
        )
      );

      if (appliedCount > 0) {
        onTripUpdated();
        if (fuelReplenishQueued) {
          onActivity?.('fuel-planning');
          try {
            await tripApi(tripId).replenishFuelStops();
          } catch (e) {
            console.warn('replenishFuelStops failed', e);
          }
          onTripUpdated();
        }
      }
      onActivity?.(applyError ? 'error' : 'response');
    } catch (err) {
      console.warn('replan stream errored', err);
      setDeliveryStatus('responded');
      failAssistant('Something went wrong. Please try again.');
      onActivity?.('error');
    } finally {
      setLoading(false);
      // Drain the message queue — send the next queued message now that Penny
      // is free. We shift one item at a time; each call to sendChatMessage
      // will re-enter this finally block and drain the next.
      const next = messageQueueRef.current.shift();
      if (next) {
        // Small delay so the UI can render setLoading(false) before the
        // next stream starts.
        await new Promise((r) => setTimeout(r, 50));
        sendChatMessage(next.text, next.images, next.msgId);
      }
    }
  };

  async function submitOnboardingPost(questionKey: string, value: unknown) {
    if (!onboardingSnapshot?.question || onboardingSubmitting) return;
    setOnboardingSubmitting(true);
    setOnboardingError(null);
    try {
      const result = await apiFetch<OnboardingAnswerResult>(`/api/trips/${tripId}/onboarding`, {
        method: 'POST',
        body: { questionKey, value },
      });
      if (result.didHandoff) {
        setOnboardingSnapshot({ state: 'done', question: null, vehicles: [], progress: null });
        setInput('');
        // Fire the stored trip intent at Penny (not the last answer — that was a vehicle question)
        const intent = result.tripIntent ?? (typeof value === 'string' ? value : String(value));
        await sendChatMessage(intent, []);
        onTripUpdated();
        // Re-focus the textarea so the keyboard stays open on mobile during
        // the transition from onboarding to normal chat.
        setTimeout(() => textareaRef.current?.focus(), 100);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: `optimistic-${Date.now()}`,
            trip_id: tripId,
            role: 'user' as const,
            content: result.answerLabel,
            kind: 'form_answer' as const,
            changes_made: null,
            created_at: new Date().toISOString(),
          },
        ]);
        setOnboardingSnapshot(result.next);
        setInput('');
      }
    } catch (e: unknown) {
      setOnboardingError(e instanceof Error ? e.message : String(e));
    } finally {
      setOnboardingSubmitting(false);
    }
  }

  async function submitOnboardingPick(rawValue: string | number) {
    const q = onboardingSnapshot?.question;
    if (!q || onboardingSubmitting || onboardingLoading) return;
    if (q.kind !== 'select') return;
    await submitOnboardingPost(q.key, rawValue);
  }

  async function submitOnboardingTextAnswer(trimmed: string) {
    const q = onboardingSnapshot?.question;
    if (!q || onboardingSubmitting || onboardingLoading) return;

    if (q.kind === 'handoff') {
      if (!trimmed) {
        setOnboardingError('Please describe your trip.');
        return;
      }
      await submitOnboardingPost(q.key, trimmed);
      return;
    }
    if (q.kind === 'text') {
      if (!trimmed) {
        setOnboardingError('This one is required.');
        return;
      }
      await submitOnboardingPost(q.key, trimmed);
      return;
    }
    if (q.kind === 'number' || q.kind === 'integer') {
      if (!trimmed) {
        setOnboardingError('This one is required.');
        return;
      }
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        setOnboardingError('Please enter a number.');
        return;
      }
      if (q.kind === 'integer' && !Number.isInteger(n)) {
        setOnboardingError('Please enter a whole number.');
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
      await submitOnboardingPost(q.key, n);
    }
  }

  // Thin wrapper — the composer path pulls text/images out of local state,
  // clears them, and delegates to the shared engine. Onboarding handoff
  // sidesteps this and calls sendChatMessage directly.
  const sendMessage = async () => {
    const trimmed = input.trim();
    const attachedImages = images;
    if (onboardingUiActive) {
      if (onboardingLoading || onboardingSubmitting) return;
      const q = onboardingSnapshot?.question;
      if (!q) return;
      if (onboardingSelectStep) return;
      if (!trimmed && attachedImages.length === 0) return;
      if (attachedImages.length > 0) {
        setOnboardingError("Images aren't available during trip setup.");
        return;
      }
      await submitOnboardingTextAnswer(trimmed);
      return;
    }
    if (showRemediation) {
      if (remLoading || remSubmitting) return;
      if (!trimmed && attachedImages.length === 0) return;
      await submitRemediationTextAnswer(trimmed);
      return;
    }
    if (!trimmed && attachedImages.length === 0) return;
    setInput('');
    setImages([]);

    if (loading) {
      // Penny is still thinking — queue this message to send when she finishes.
      const queuedMsgId = `optimistic-${Date.now()}`;
      messageQueueRef.current.push({ text: trimmed, images: attachedImages, msgId: queuedMsgId });
      // Show the queued message as an optimistic bubble with 'queued' status.
      setMessages((prev) => [
        ...prev,
        {
          id: queuedMsgId,
          trip_id: tripId,
          role: 'user' as const,
          content: trimmed,
          kind: 'ai' as const,
          changes_made: null,
          created_at: new Date().toISOString(),
          imageDataUrls: attachedImages.map((i) => i.dataUrl),
          deliveryStatus: 'queued' as DeliveryStatus,
        },
      ]);
      return;
    }
    await sendChatMessage(trimmed, attachedImages);
  };

  async function applyRemediationSnapshot(data: VehicleRemediationSnapshot, answeredLabel: string) {
    setRemSnapshot(data);
    setRemError(null);
    setInput('');
    setMessages((prev) => [
      ...prev,
      {
        id: `optimistic-${Date.now()}`,
        trip_id: tripId,
        role: 'user' as const,
        content: answeredLabel,
        kind: 'form_answer' as const,
        changes_made: null,
        created_at: new Date().toISOString(),
      },
    ]);
    if (data.done || !data.needs_remediation) {
      setRemediationDone(true);
      setMessages((prev) => [
        ...prev,
        {
          id: `optimistic-${Date.now()}`,
          trip_id: tripId,
          role: 'assistant' as const,
          content: "Vehicle profile updated! You're all set to plan your trip.",
          kind: 'ai' as const,
          changes_made: null,
          created_at: new Date().toISOString(),
        },
      ]);
    }
  }

  async function submitRemediationTextAnswer(trimmed: string) {
    const q = remSnapshot?.question;
    if (!q || remSubmitting || q.kind === 'select') return;

    let value: string | number | null = trimmed;
    if (trimmed === '' && q.optional) {
      value = null;
    } else if (trimmed === '' && !q.optional) {
      setRemError('This one is required.');
      return;
    }

    if (q.kind === 'number' || q.kind === 'integer') {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        setRemError('Please enter a number.');
        return;
      }
      if (q.kind === 'integer' && !Number.isInteger(n)) {
        setRemError('Please enter a whole number.');
        return;
      }
      if (q.min !== undefined && n < q.min) {
        setRemError(`Must be at least ${q.min}.`);
        return;
      }
      if (q.max !== undefined && n > q.max) {
        setRemError(`Must be at most ${q.max}.`);
        return;
      }
      value = n;
    }

    let userLabel = trimmed === '' ? 'Skipped' : trimmed;
    if (value !== null && typeof value === 'number') userLabel = String(value);

    setRemSubmitting(true);
    try {
      const data = await apiFetch<VehicleRemediationSnapshot>('/api/me/vehicle-remediation', {
        method: 'POST',
        body: { questionKey: q.key, value },
      });
      await applyRemediationSnapshot(data, userLabel);
    } catch (e: unknown) {
      setRemError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemSubmitting(false);
    }
  }

  async function submitRemediationSelect(value: string, userLabel: string) {
    const q = remSnapshot?.question;
    if (!q || q.kind !== 'select' || remSubmitting) return;
    setRemSubmitting(true);
    try {
      const data = await apiFetch<VehicleRemediationSnapshot>('/api/me/vehicle-remediation', {
        method: 'POST',
        body: { questionKey: q.key, value },
      });
      await applyRemediationSnapshot(data, userLabel);
    } catch (e: unknown) {
      setRemError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemSubmitting(false);
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length && attachImagesAllowed) {
      e.preventDefault();
      addImageFiles(files);
    }
  };

  useEffect(() => {
    if (showRemediation || isOnboarding) setImages([]);
  }, [showRemediation, isOnboarding]);

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (showRemediation || isOnboarding) return;
    if (e.dataTransfer?.files?.length) {
      addImageFiles(e.dataTransfer.files);
    }
  };

  const remediationComposerBusy = showRemediation && (remLoading || remSubmitting);
  const onboardingComposerBusy = onboardingUiActive && (onboardingLoading || onboardingSubmitting);

  // For the disabled prop we only include the *loading* states (initial fetch)
  // — not the *submitting* states. Disabling the textarea during submit blurs
  // it, which closes the mobile keyboard and breaks the back-and-forth chat
  // feel. Double-submit is already guarded by early-returns in sendMessage /
  // submitOnboardingTextAnswer / submitRemediationTextAnswer.
  const remediationComposerDisabled = showRemediation && remLoading;
  const onboardingComposerDisabled = onboardingUiActive && (onboardingLoading || introTyping);
  const remediationSelectStep =
    showRemediation &&
    remSnapshot?.question?.kind === 'select' &&
    !remSnapshot?.garage_empty;
  const remediationQuestion = remSnapshot?.question ?? null;

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!showRemediation && !isOnboarding && e.dataTransfer?.types?.includes('Files')) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={handleDrop}
      style={{
        display: 'flex',
        flexDirection: 'column',
        // Fill whatever space the parent flex container gives us. `min-height: 0`
        // is required so the inner messages-scroll area can shrink and leave
        // real layout space for the input row at the bottom (a Safari foot-gun
        // — without it the input renders below the visible viewport on mobile
        // and disappears behind the bottom nav).
        flex: 1,
        minHeight: 0,
        // Fallback for parents that lay this out as a non-flex item.
        height: '100%',
        background: 'var(--tp-surface-muted)',
        position: 'relative',
      }}
    >
      {dragOver && attachImagesAllowed && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'var(--tp-primary-muted)',
            border: '2px dashed rgba(78, 122, 176, 0.45)',
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--tp-primary)',
            fontSize: 14,
            fontWeight: 600,
            pointerEvents: 'none',
          }}
        >
          Drop image to attach
        </div>
      )}

      {/* Header */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--tp-border)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: 'linear-gradient(145deg, var(--tp-primary) 0%, var(--tp-success) 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--tp-on-primary)',
            fontWeight: 800,
            fontSize: 13,
            flexShrink: 0,
          }}
        >
          P
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--tp-text)', lineHeight: 1.1 }}>
            Penny
          </div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--tp-subtle)',
              
              letterSpacing: '0.04em',
              marginTop: 2,
            }}
          >
            Feral Travels AI
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '16px 16px 8px',
          display: 'flex',
          flexDirection: 'column',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {/* Spacer: pushes messages to the bottom (like iMessage) when there
            are only a few. `flex: 1` absorbs all leftover space but collapses
            to zero once messages overflow — so you can always scroll to the
            first message. Don't use justifyContent:flex-end because that makes
            the top messages unreachable in an overflow container. */}
        <div style={{ flex: 1 }} />

        {hasMore && (
          <div
            style={{
              textAlign: 'center',
              fontSize: 11,
              color: 'var(--tp-subtle)',

              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              padding: '4px 0 6px',
            }}
          >
            {loadingOlder ? (
              'Loading older messages…'
            ) : (
              <button
                onClick={() => loadOlder()}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--tp-border)',
                  color: 'var(--tp-muted)',
                  padding: '4px 10px',
                  borderRadius: 10,
                  fontSize: 11,
                  cursor: 'pointer',
                  
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                }}
              >
                Load older
              </button>
            )}
          </div>
        )}
        {messages.length === 0 && (
          <div />
        )}

        {messages.map((msg, msgIdx) => {
          // Hide the empty assistant bubble while waiting for Penny's first
          // chunk — the 3-dot typing indicator covers this state.
          if (msg.role === 'assistant' && msg.streaming && !msg.content && !(msg.inFlightTools?.length)) {
            return null;
          }
          const gp = getGroupPosition(messages, msgIdx);
          // Tight 2px gap inside a group, 10px between groups.
          const marginTop = msgIdx === 0 ? 0 : gp.isFirst ? 10 : 2;
          const isQueued = msg.deliveryStatus === 'queued';
          return (
          <div
            key={msg.id}
            style={{
              maxWidth: '80%',
              alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
              display: 'flex',
              flexDirection: 'column',
              alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
              marginTop,
              opacity: isQueued ? 0.5 : 1,
              transition: 'opacity 0.3s ease',
            }}
          >
          <div
            style={{
              padding: '8px 14px',
              borderRadius: bubbleRadius(msg.role, gp),
              background: msg.role === 'user'
                ? 'var(--tp-primary-muted)'
                : 'var(--tp-surface)',
              fontSize: 14,
              color: 'var(--tp-text)',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
            }}
          >
            {msg.imageDataUrls && msg.imageDataUrls.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: msg.content ? 8 : 0 }}>
                {msg.imageDataUrls.map((url, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={url}
                    alt="attachment"
                    style={{
                      maxWidth: 180,
                      maxHeight: 180,
                      borderRadius: 6,
                      border: '1px solid var(--tp-border)',
                      objectFit: 'cover',
                    }}
                  />
                ))}
              </div>
            )}
            {msg.content}
            {msg.streaming && msg.content && (
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  marginLeft: 2,
                  width: 6,
                  height: 14,
                  background: 'var(--tp-muted)',
                  verticalAlign: '-2px',
                  animation: 'tp-cursor-blink 1s steps(2, start) infinite',
                }}
              />
            )}
            {msg.changes_made && !msg.applyError && (
              <div
                style={{
                  marginTop: 8,
                  padding: '6px 8px',
                  background: 'var(--tp-success-muted)',
                  borderRadius: 4,
                  border: '1px solid rgba(74, 139, 122, 0.28)',
                  fontSize: 11,
                  color: 'var(--tp-success)',

                }}
              >
                Changes applied to trip
              </div>
            )}
            {/* routeSummary data is still stored on the message but hidden from the UI for now */}
            {msg.partialApplyWarning && (
              <div
                style={{
                  marginTop: 8,
                  padding: '6px 8px',
                  background: 'rgba(212, 160, 23, 0.12)',
                  borderRadius: 4,
                  border: '1px solid rgba(212, 160, 23, 0.35)',
                  fontSize: 11,
                  color: 'var(--tp-text)',
                  lineHeight: 1.45,
                }}
              >
                {msg.partialApplyWarning}
              </div>
            )}
            {msg.applyError && (
              <div
                style={{
                  marginTop: 8,
                  padding: '6px 8px',
                  background: 'var(--tp-danger-muted)',
                  borderRadius: 4,
                  border: '1px solid rgba(198, 93, 74, 0.35)',
                  fontSize: 11,
                  color: 'var(--tp-danger)',

                  lineHeight: 1.45,
                }}
              >
                {msg.applyError}
              </div>
            )}
            {msg.truncated && (
              <div
                style={{
                  marginTop: 8,
                  padding: '8px 10px',
                  background: 'var(--tp-danger-muted)',
                  borderRadius: 4,
                  border: '1px solid rgba(198, 93, 74, 0.35)',
                  fontSize: 12,
                  color: 'var(--tp-text)',
                  lineHeight: 1.45,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ color: 'var(--tp-danger)', fontWeight: 600 }}>
                  Penny didn&apos;t finish your plan
                </div>
                <div style={{ color: 'var(--tp-muted)' }}>
                  She ran out of room mid-plan and saved partial work. Click below to keep going from where she stopped.
                </div>
                <button
                  onClick={() =>
                    sendChatMessage(
                      'Continue planning the trip from where you left off. Add the remaining legs.'
                    )
                  }
                  disabled={loading}
                  style={{
                    alignSelf: 'flex-start',
                    marginTop: 2,
                    padding: '5px 10px',
                    background: loading ? 'var(--tp-border)' : 'var(--tp-primary)',
                    color: loading ? 'var(--tp-subtle)' : 'var(--tp-on-primary)',
                    border: 'none',
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                    cursor: loading ? 'default' : 'pointer',
                  }}
                >
                  Continue planning
                </button>
              </div>
            )}
          </div>
          {/* Delivery receipt — iMessage shows status on the last user message
              only, not every message. We check that this is the final user msg
              in the list (no later user message exists). */}
          {msg.role === 'user' &&
            msg.deliveryStatus &&
            !messages.slice(msgIdx + 1).some((m) => m.role === 'user') && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--tp-subtle)',
                marginTop: 2,
                textAlign: 'right',
                transition: 'opacity 0.3s ease',
              }}
            >
              {msg.deliveryStatus === 'queued' && 'Queued'}
              {msg.deliveryStatus === 'sending' && 'Sending…'}
              {msg.deliveryStatus === 'delivered' && (
                <span style={{ color: 'var(--tp-muted)' }}>Delivered</span>
              )}
              {msg.deliveryStatus === 'read' && (
                <span style={{ color: 'var(--tp-primary)' }}>Read</span>
              )}
              {msg.deliveryStatus === 'typing' && (
                <span style={{ color: 'var(--tp-primary)', fontStyle: 'italic' }}>Penny is typing…</span>
              )}
              {msg.deliveryStatus === 'responded' && (
                <span style={{ color: 'var(--tp-muted)' }}>Read</span>
              )}
            </div>
          )}
          </div>
          );
        })}

        {/* Typing indicator — shown when Penny has "read" the message
            but hasn't started responding yet (no text chunks received),
            or during the typing animation before each onboarding question. */}
        {(introTyping || (loading && !messages.some((m) => m.id?.startsWith('optimistic-') && m.role === 'assistant' && m.content))) && (
          <div
            style={{
              alignSelf: 'flex-start',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 5,
              padding: '12px 16px',
              borderRadius: 18,
              background: 'var(--tp-surface)',
              marginTop: 10,
            }}
          >
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                style={{
                  display: 'block',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: 'var(--tp-muted)',
                  animation: `tp-dot-pulse 1.4s ease-in-out ${i * 0.2}s infinite`,
                }}
              />
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Attachment thumbnails */}
      {images.length > 0 && !showRemediation && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            padding: '8px 16px 0',
            flexWrap: 'wrap',
            flexShrink: 0,
          }}
        >
          {images.map((img) => (
            <div
              key={img.id}
              style={{
                position: 'relative',
                width: 56,
                height: 56,
                borderRadius: 6,
                overflow: 'hidden',
                border: '1px solid var(--tp-border)',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.dataUrl}
                alt={img.name}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
              <button
                onClick={() => removeImage(img.id)}
                style={{
                  position: 'absolute',
                  top: 2,
                  right: 2,
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  border: 'none',
                  background: 'var(--tp-overlay)',
                  color: 'var(--tp-on-primary)',
                  fontSize: 12,
                  lineHeight: '18px',
                  cursor: 'pointer',
                  padding: 0,
                }}
                aria-label="Remove image"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {readonly ? (
        <div
          style={{
            padding: '12px 16px',
            borderTop: '1px solid var(--tp-border)',
            color: 'var(--tp-muted)',
            fontSize: 12,
            textAlign: 'center',
            
            flexShrink: 0,
            paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
          }}
        >
          Demo trip — clone it from the trips list to chat with Penny.
        </div>
      ) : (
        <>
          {onboardingBlockingLoad ? (
            <div
              style={{
                padding: '12px 16px',
                borderTop: '1px solid var(--tp-border)',
                flexShrink: 0,
                background: 'var(--tp-surface-muted)',
                color: 'var(--tp-muted)',
                fontSize: 13,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
              }}
            >
              <Spinner size={12} thickness={2} color="var(--tp-primary)" /> Loading setup…
            </div>
          ) : (
            <>
              {onboardingUiActive && onboardingSnapshot?.progress && (
                <div
                  style={{
                    padding: '8px 16px 0',
                    flexShrink: 0,
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--tp-primary)',
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    background: 'var(--tp-surface-muted)',
                  }}
                >
                  Setup · {onboardingSnapshot.progress.current} of {onboardingSnapshot.progress.total}
                </div>
              )}
              {onboardingUiActive &&
                onboardingQuestion?.kind === 'select' &&
                onboardingQuestion.options && (
                  <div
                    style={{
                      padding: '10px 16px 10px',
                      flexShrink: 0,
                      borderTop: '1px solid var(--tp-border)',
                      background: 'var(--tp-surface-muted)',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--tp-muted)',
                        marginBottom: 6,
                        letterSpacing: '0.03em',
                      }}
                    >
                      Tap an option
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {onboardingQuestion.options.map((o) => (
                        <button
                          key={o.value}
                          type="button"
                          disabled={onboardingComposerBusy}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => void submitOnboardingPick(o.value)}
                          style={{
                            padding: '8px 14px',
                            background: 'var(--tp-surface)',
                            border: '1px solid var(--tp-border)',
                            borderRadius: 999,
                            color: 'var(--tp-text)',
                            fontSize: 13,
                            cursor: onboardingComposerBusy ? 'default' : 'pointer',
                            opacity: onboardingComposerBusy ? 0.5 : 1,
                          }}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              {remediationSelectStep && remSnapshot.question?.options && (
            <div
              style={{
                padding: '10px 16px 0',
                flexShrink: 0,
                borderTop: '1px solid var(--tp-border)',
                background: 'var(--tp-surface-muted)',
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--tp-muted)',
                  marginBottom: 6,
                  letterSpacing: '0.03em',
                }}
              >
                Tap an option
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {remSnapshot.question.options.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    disabled={remediationComposerBusy}
                    onClick={() => void submitRemediationSelect(o.value, o.label)}
                    style={{
                      padding: '8px 14px',
                      background: 'var(--tp-surface)',
                      border: '1px solid var(--tp-border)',
                      borderRadius: 999,
                      color: 'var(--tp-text)',
                      fontSize: 13,
                      cursor: remediationComposerBusy ? 'default' : 'pointer',
                      opacity: remediationComposerBusy ? 0.5 : 1,
                    }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {showRemediation && remSnapshot?.active_vehicle && !remSnapshot.garage_empty && (
            <div
              style={{
                padding: '8px 16px 0',
                flexShrink: 0,
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--tp-primary)',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                background: 'var(--tp-surface-muted)',
              }}
            >
              Vehicle: {remSnapshot.active_vehicle.name}
              {remSnapshot.progress
                ? ` · ${remSnapshot.progress.current} of ${remSnapshot.progress.total}`
                : ''}
            </div>
          )}
          <div
        style={{
          padding: '12px 16px',
          borderTop: '1px solid var(--tp-border)',
          // Without this, the input block can compress to zero height on
          // mobile Safari when the flex container is short (e.g. inside a
          // position:absolute mobile tab pane) — leaving the user with no
          // textbox to type in.
          flexShrink: 0,
          background: 'var(--tp-surface-muted)',
          // Respect iOS home-indicator / Android gesture-bar safe area so
          // the send button isn't hidden behind the OS affordance.
          paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files) addImageFiles(e.target.files);
            e.target.value = '';
          }}
        />
        {remError && (
          <div style={{ fontSize: 12, color: 'var(--tp-danger)', marginBottom: 8 }}>{remError}</div>
        )}
        {onboardingError && (
          <div style={{ fontSize: 12, color: 'var(--tp-danger)', marginBottom: 8 }}>{onboardingError}</div>
        )}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 6,
            background: 'var(--tp-surface)',
            border: '1px solid var(--tp-border)',
            borderRadius: 20,
            padding: '4px 6px',
            transition: 'border-color 0.15s',
          }}
        >
          {attachImagesAllowed && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            title="Attach image"
            aria-label="Attach image"
            style={{
              width: 32,
              height: 32,
              flexShrink: 0,
              padding: 0,
              background: 'transparent',
              border: 'none',
              borderRadius: 8,
              color: 'var(--tp-muted)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--tp-primary-muted)';
              e.currentTarget.style.color = 'var(--tp-primary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--tp-muted)';
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          )}
          <textarea
            ref={textareaRef}
            data-testid="trip-chat-composer"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            readOnly={Boolean(remediationSelectStep || onboardingSelectStep)}
            enterKeyHint="send"
            onFocus={() => {
              if (showRemediation || onboardingUiActive) return;
              // Scroll the messages container to bottom when the textarea
              // gets focus — keeps the latest messages visible above the
              // keyboard. We use scrollToBottom (scrollTop-based) instead of
              // scrollIntoView to avoid iOS Safari dismissing the keyboard.
              setTimeout(() => scrollToBottom(), 250);
            }}
            placeholder={
              onboardingSelectStep
                ? 'Tap an option above…'
                : onboardingUiActive && onboardingQuestion
                  ? onboardingQuestion.placeholder ?? 'Type your answer…'
                  : remediationSelectStep
                    ? 'Tap an option above…'
                    : showRemediation && remSnapshot?.question
                      ? remSnapshot.question.placeholder ?? 'Type your answer…'
                      : 'Ask Penny…'
            }
            disabled={remediationComposerDisabled || onboardingComposerDisabled}
            rows={1}
            style={{
              flex: 1,
              minWidth: 0,
              boxSizing: 'border-box',
              padding: '7px 4px',
              background: 'transparent',
              border: 'none',
              color: 'var(--tp-text)',
              fontSize: 14,
              outline: 'none',
              fontFamily: 'inherit',
              resize: 'none',
              lineHeight: 1.4,
              // ~1 line + vertical padding. Keeps the input from collapsing
              // to a sliver if the autoresize effect runs while the pane is
              // hidden (scrollHeight === 0).
              minHeight: 34,
              maxHeight: 200,
              overflowY: 'auto',
              display: 'block',
            }}
          />
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={sendMessage}
            disabled={
              Boolean(
                remediationComposerBusy ||
                  onboardingComposerBusy ||
                  (!showRemediation &&
                    !onboardingUiActive &&
                    !input.trim() &&
                    images.length === 0) ||
                  (showRemediation &&
                    remediationQuestion &&
                    !input.trim() &&
                    remediationQuestion.optional !== true) ||
                  (onboardingUiActive &&
                    onboardingQuestion &&
                    !onboardingSelectStep &&
                    !input.trim())
              )
            }
            aria-label="Send"
            title="Send"
            style={{
              width: 30,
              height: 30,
              flexShrink: 0,
              padding: 0,
              background:
                ((!showRemediation &&
                  !onboardingUiActive &&
                  (input.trim() || images.length > 0)) ||
                  (showRemediation &&
                    remSnapshot?.question &&
                    (input.trim() || remSnapshot.question.optional === true)) ||
                  (onboardingUiActive &&
                    onboardingQuestion &&
                    !onboardingSelectStep &&
                    input.trim())) &&
                !remediationComposerBusy &&
                !onboardingComposerBusy
                  ? 'var(--tp-primary)'
                  : 'var(--tp-border)',
              border: 'none',
              borderRadius: '50%',
              color:
                ((!showRemediation &&
                  !onboardingUiActive &&
                  (input.trim() || images.length > 0)) ||
                  (showRemediation &&
                    remSnapshot?.question &&
                    (input.trim() || remSnapshot.question.optional === true)) ||
                  (onboardingUiActive &&
                    onboardingQuestion &&
                    !onboardingSelectStep &&
                    input.trim())) &&
                !remediationComposerBusy &&
                !onboardingComposerBusy
                  ? 'var(--tp-on-primary)'
                  : 'var(--tp-subtle)',
              cursor:
                ((!showRemediation &&
                  !onboardingUiActive &&
                  (input.trim() || images.length > 0)) ||
                  (showRemediation &&
                    remSnapshot?.question &&
                    (input.trim() || remSnapshot.question.optional === true)) ||
                  (onboardingUiActive &&
                    onboardingQuestion &&
                    !onboardingSelectStep &&
                    input.trim())) &&
                !remediationComposerBusy &&
                !onboardingComposerBusy
                  ? 'pointer'
                  : 'default',
              transition: 'background 0.15s, color 0.15s',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          </button>
        </div>
        {/* Hint text — only shown during remediation. Onboarding no longer
            shows helper text under the composer. */}
        {showRemediation && (
          <div
            style={{
              marginTop: 6,
              fontSize: 10,
              color: 'var(--tp-subtle)',
              letterSpacing: '0.04em',
              textAlign: 'center',
            }}
          >
            Vehicle setup
          </div>
        )}
      </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
