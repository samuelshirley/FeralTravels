'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { ChatMessage, OnboardingState, PlanSummary } from '@/types/trip';
import { apiFetch } from '@/lib/api';
import { useUnits } from '@/components/UnitsContext';
import { formatKm } from '@/lib/units';
import { formatDate, parseISODate } from '@/lib/dates';
import { deriveApplyOutcome } from '@/lib/penny/applyOutcome';
import Spinner from '@/components/Spinner';
import PennyPlanningVideo from '@/components/PennyPlanningVideo';
import PurchaseSheet from '@/components/PurchaseSheet';
import { SUPPORT_EMAIL } from '@/lib/paywallCopy';
import { PAYWALL_ERROR_CODE } from '@/types/entitlement';
import type { EntitlementPayload, PaywallErrorBody } from '@/types/entitlement';
// Imported, not restated: the native client derives its bubble with this same
// id, and two hardcoded copies of it is how they quietly stop matching.
import { PAYWALL_MESSAGE_ID } from '@/lib/paywallNotice';
import { PaperclipIcon, SendArrowIcon } from '@/components/icons';
import { buttonStyle } from '@/components/ui/Button';

/**
 * Terminal payload shape the server emits as the `applied` SSE event AND stores
 * on the durable `penny_turns` record. The live stream and the reconcile/heal
 * path both apply it, so a turn looks identical whether the client saw it live
 * or healed it on reopen. See docs/design/penny-turn-resilience.md.
 */
type AppliedEvent = {
  response: string;
  changes: { changes: unknown[] };
  appliedCount: number;
  failedCount: number;
  failedActions: Array<{ action: string; error: string }>;
  /** DB / feasibility failures — use for user-visible save warnings. */
  persistFailedCount?: number;
  persistFailedActions?: Array<{ action: string; error: string }>;
  /** Exhausted validation retries; not indicative of unsuccessful writes. */
  validationFailures?: Array<{ action: string; error: string }>;
  /** Validated tool actions queued this turn — may exceed `changes.changes`. */
  validatedQueuedCount?: number;
  /** True when an inline plan_fuel_stops lookup wrote stops this turn. */
  fuelStopsChanged: boolean;
  /** Deterministic, DB-derived plan facts (source of truth for numbers). */
  planSummary?: PlanSummary | null;
  truncated: boolean;
};

/** Client view of a `penny_turns` row returned by the reconcile endpoint. */
type TurnRecord = {
  idempotency_key: string;
  status: 'queued' | 'running' | 'done' | 'error';
  result_response: string | null;
  result_meta: AppliedEvent | null;
  error_message: string | null;
};

/**
 * Stable per-send id — the idempotency anchor for the durable turn record. A
 * retry carrying the same key returns the existing turn instead of spawning a
 * second replan. `crypto.randomUUID` is available in all secure-context
 * browsers; the fallback keeps non-secure/legacy contexts working.
 */
function makeIdempotencyKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `k-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Caption Penny "sends" alongside the dog-fetch clip on the first full build. */
const PLANNING_VIDEO_COPY = 'Give me a sec — mapping your route and finding fuel…';

/**
 * Stable id for the paywall bubble appended on mount, so a re-run of the
 * entitlement effect replaces it rather than stacking a second copy.
 */

/**
 * Penny's paywall copy, as paragraphs.
 *
 * The bubble is already `white-space: pre-wrap`, so the `\n\n` in the server's
 * message would technically render — as a bare blank line at the bubble's own
 * line-height, which is what a stray newline in a streamed reply looks like.
 * This is the one bubble whose text was written rather than streamed, and the
 * one the user is being asked to read and act on, so it gets real paragraph
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
        <div key={i} style={{ marginTop: i === 0 ? 0 : 10 }}>
          {para}
        </div>
      ))}
    </>
  );
}

interface ChatPanelProps {
  tripId: string;
  initialMessages: ChatMessage[];
  initialHasMore?: boolean;
  /**
   * When not 'done', the normal composer submits answers to
   * `/api/trips/:id/onboarding` until handoff, then Penny streams as usual.
   */
  onboardingState?: OnboardingState;
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

/** Shape of an onboarding form question (GET `/api/trips/:id/onboarding`). */
interface OnboardingFormQuestion {
  key: string;
  kind: 'text' | 'number' | 'integer' | 'select' | 'chips' | 'handoff';
  label: string;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
  optional?: boolean;
  min?: number;
  max?: number;
  multiline?: boolean;
  defaultValue?: string;
  /**
   * Tappable examples that PREFILL the composer and do NOT submit — unlike
   * `options`, which are answers. See the server type for why both exist.
   */
  prompts?: string[];
  /** One quiet line explaining where a `defaultValue` came from. */
  footnote?: string;
}

/** GET `/api/trips/:id/onboarding` — shape matches server snapshot. */
interface OnboardingSnapshot {
  state: OnboardingState;
  question: OnboardingFormQuestion | null;
  vehicles: Array<{ id: string; name: string; is_default: boolean }>;
  progress: { current: number; total: number } | null;
}

interface OnboardingAnswerResult {
  next: OnboardingSnapshot;
  answerLabel: string;
  didHandoff: boolean;
  /** The stored trip intent to send to Penny when onboarding is done. */
  tripIntent?: string;
  /** Deterministic Penny acknowledgment (e.g. confirming/placeholdering the start date). */
  note?: string;
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
/**
 * The three on-trip prompt rows, and the on-trip equivalents of onboarding's
 * first-run ones. Each is a DIFFERENT shape of request rather than three
 * phrasings of the same one — a plan, a position report with a tank state, and
 * an edit — because their job is to show the range of what Penny takes, not to
 * be tapped verbatim.
 */
const CHAT_STARTERS = [
  'Girona to Lisbon, 5 h days',
  "I'm in Reims, 150 km in the tank",
  'Add a rest day in Strasbourg',
] as const;

type DeliveryStatus = 'queued' | 'sending' | 'delivered' | 'read' | 'typing' | 'responded';

interface UIMessage extends Omit<ChatMessage, 'seq' | 'plan_summary'> {
  /** Sequential ordering number — 0 or absent for optimistic (unsaved) messages. */
  seq?: number;
  imageDataUrls?: string[];
  // Populated when Penny proposed changes but the server couldn't apply them
  // (unknown action, owner mismatch, DB error). We surface this so the user
  // doesn't see a misleading "Changes applied to trip" badge.
  applyError?: string | null;
  /** When some writes succeeded AND some failed — show success + this warning */
  partialApplyWarning?: string | null;
  /**
   * Deterministic, DB-derived plan facts for this turn (day counts, dates,
   * totals). Optional here because optimistic/streaming
   * messages don't have it yet; persisted + history-loaded messages do. This
   * is the source of truth the card renders — never Penny's prose.
   */
  plan_summary?: PlanSummary | null;
  // True when the replan response had truncated=true — i.e. Penny hit the
  // tool-use iteration cap mid-plan and only persisted partial work. We
  // surface a warning + 'Continue planning' button on the bubble. UI-only;
  // not persisted, so historical messages from a page reload never show it.
  truncated?: boolean;
  /** True while the SSE stream is still appending paragraphs. */
  streaming?: boolean;
  /** Delivery lifecycle for user messages (sending → delivered → read → typing → responded). */
  deliveryStatus?: DeliveryStatus;
  /**
   * UI-only marker for the dog-fetch clip Penny "sends" at the start of the
   * post-onboarding full-trip build. Rendered as a persistent looping video
   * bubble (PennyPlanningVideo) with `content` as the caption. Not persisted to
   * chat history, so it doesn't survive a page reload — it lives for the session
   * so the user can scroll back to it while Penny builds the plan.
   */
  planningMedia?: boolean;
  /**
   * UI-only marker for Penny's paywall message.
   *
   * The paywall is a message in the transcript, not a sheet thrown over the
   * app: the user opens the trip, lands where they always land, and Penny tells
   * them herself. So it is a message — but a SYNTHETIC one. It is never written
   * to `chat_history`, because it is a statement about the account's billing at
   * one moment, not something Penny said; persisting it would leave a stale
   * "your trial is up" sitting in the transcript of a paying subscriber
   * forever. It is appended on mount when `/api/me/entitlement` says the
   * account is not entitled, and it replaces the bubble in place when a 402
   * comes back mid-conversation.
   *
   * The flag carries no copy of its own. `content` is the server's
   * `paywall.message` and the button label comes from the same payload, so the
   * wording can change without a build — see `src/server/payments/copy.ts`.
   */
  paywall?: boolean;
  /**
   * Idempotency key of the replan turn that produced this assistant bubble.
   * Lets the client re-attach to the durable `penny_turns` record and heal a
   * false "Something went wrong" bubble (or finish a queued turn) on reopen.
   * Session-only — not persisted to chat history.
   */
  turnKey?: string;
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

/** minutes → "~5h 12m" / "~45m" — planning-grade, not odometer-grade. */
function formatDuration(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  if (h <= 0) return `~${m}m`;
  return m > 0 ? `~${h}h ${m}m` : `~${h}h`;
}

function fmtPlanDate(iso: string | null, units: ReturnType<typeof useUnits>['units']): string | null {
  if (!iso) return null;
  return formatDate(parseISODate(iso), units);
}

/** "HH:MM" → "08:00" (metric, 24h) or "8:00 AM" (imperial, 12h). */
function formatClock(
  hhmm: string | null | undefined,
  units: ReturnType<typeof useUnits>['units'],
): string | null {
  if (!hhmm) return null;
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  if (units === 'imperial') {
    const period = h < 12 ? 'AM' : 'PM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${period}`;
  }
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Minutes of slack → "26 min" / "2h 10m" (absolute value). */
/**
 * Deterministic plan summary card. Renders the DB-derived facts that Penny is
 * forbidden from stating in prose — day counts, dates, totals —
 * so the numbers the user sees are always the plan that actually saved. Penny's
 * bubble above is the conversational wrapper; THIS is the source of truth.
 */
function PlanSummaryCard({
  summary,
  units,
}: {
  summary: PlanSummary;
  units: ReturnType<typeof useUnits>['units'];
}) {
  const departDate = fmtPlanDate(summary.depart_date_iso, units);
  const arriveDate = fmtPlanDate(summary.arrive_date_iso, units);
  const departTime = formatClock(summary.depart_time, units);
  const arriveTime = formatClock(summary.arrive_time, units);

  const dayBits = [`${summary.total_days} day${summary.total_days !== 1 ? 's' : ''}`];
  if (summary.drive_days > 0) dayBits.push(`${summary.drive_days} driving`);
  if (summary.rest_days > 0) dayBits.push(`${summary.rest_days} rest`);

  const labelStyle: React.CSSProperties = { color: 'var(--tp-muted)', marginRight: 6 };
  return (
    <div
      style={{
        marginTop: 8,
        padding: '8px 10px',
        background: 'var(--tp-surface, rgba(127,127,127,0.06))',
        borderRadius: 6,
        border: '1px solid rgba(127, 127, 127, 0.22)',
        fontSize: 11.5,
        color: 'var(--tp-text)',
        lineHeight: 1.6,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <div style={{ fontWeight: 600 }}>{dayBits.join(' · ')}</div>
      {departDate && (
        <div>
          <span style={labelStyle}>Depart</span>
          {summary.depart_name ? `${summary.depart_name} · ` : ''}
          {departDate}
          {departTime ? ` · leave ${departTime}` : ''}
        </div>
      )}
      {arriveDate && (
        <div>
          <span style={labelStyle}>Arrive</span>
          {summary.arrive_name ? `${summary.arrive_name} · ` : ''}
          {arriveDate}
          {arriveTime ? ` · ETA ~${arriveTime}` : ''}
        </div>
      )}
      {summary.total_drive_minutes > 0 && (
        <div>
          <span style={labelStyle}>Driving</span>
          {formatDuration(summary.total_drive_minutes)}
          {summary.total_distance_km > 0 ? ` · ${formatKm(summary.total_distance_km, units)}` : ''}
        </div>
      )}
      {summary.nights_per_stop.length > 0 && (
        <div>
          <span style={labelStyle}>Nights</span>
          {summary.nights_per_stop
            .map((s) => `${s.name ?? 'stop'} ${s.nights}`)
            .join(' · ')}
        </div>
      )}
    </div>
  );
}

export default function ChatPanel({
  tripId,
  initialMessages,
  initialHasMore = false,
  onboardingState = 'done',
  onTripUpdated,
  onActivity,
  readonly = false,
}: ChatPanelProps) {
  const { units } = useUnits();
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
  /*
   * This locks the composer read-only, so it must stay `=== 'select'` and NOT
   * widen to include 'chips'. That is the entire difference between the two
   * kinds: a select is answered by tapping and nothing else, while a chips
   * step offers shortcuts AND keeps typing available — "the second week of
   * June" is a valid start date and no chip can express it.
   */
  const onboardingSelectStep =
    onboardingUiActive &&
    onboardingQuestion &&
    onboardingQuestion.kind === 'select';
  const attachImagesAllowed = !isOnboarding;
  const [messages, setMessages] = useState<UIMessage[]>(initialMessages);
  // Latest messages, readable from event handlers (visibilitychange reconcile)
  // without re-binding the listener on every message change.
  const messagesRef = useRef<UIMessage[]>(initialMessages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  /* ── Paywall ────────────────────────────────────────────────────────────
   * Penny's own message in the transcript, with the purchase button inside her
   * bubble. Deliberately NOT a modal: the only modal in this flow is the
   * purchase sheet itself, which stands in for Apple's StoreKit sheet.
   *
   * The component holds the whole entitlement payload rather than a boolean,
   * because everything shown — the message, the button label, the prices,
   * whether this browser can complete a purchase at all — is server-authored
   * and arrives together. Nothing about the paywall is decided here.
   */
  const [entitlement, setEntitlement] = useState<EntitlementPayload | null>(null);
  const [purchaseSheetOpen, setPurchaseSheetOpen] = useState(false);
  const [purchasingId, setPurchasingId] = useState<string | null>(null);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);

  /** Null entitlement means "not asked yet / couldn't ask" — never a block. */
  const paywalled = entitlement !== null && !entitlement.entitled;
  /**
   * Two of the four block reasons have nothing to sell. A capped account is our
   * ceiling, not the user's fault, and a revoked one cannot be bought back — so
   * the button is a mailto to a human, and the purchase sheet never opens.
   */
  const paywallSupportOnly =
    entitlement?.blockReason === 'usage_cap' || entitlement?.blockReason === 'revoked';

  const fetchEntitlement = useCallback(async (): Promise<EntitlementPayload | null> => {
    try {
      // Raw fetch rather than apiFetch: a failure here must not reach the
      // global ErrorNotifier. Not knowing the entitlement is a silent no-op —
      // every route that spends money gates itself and answers 402 — whereas a
      // toast would put an error in front of someone who has done nothing.
      const res = await fetch('/api/me/entitlement', { cache: 'no-store' });
      if (!res.ok) return null;
      return (await res.json()) as EntitlementPayload;
    } catch {
      return null;
    }
  }, []);

  // Ask once, on mount. A paywalled user reads Penny's message and finds the
  // composer already closed, so the first thing they learn about their billing
  // is never a red error bubble bounced back off a request they were allowed to
  // make. Skipped in readonly (the demo trip), where the composer is replaced
  // wholesale and there is nothing to gate.
  useEffect(() => {
    if (readonly) return;
    let cancelled = false;
    void (async () => {
      const payload = await fetchEntitlement();
      if (cancelled || !payload) return;
      setEntitlement(payload);
      const copy = payload.paywall;
      if (payload.entitled || !copy) return;
      setMessages((prev) =>
        prev.some((m) => m.paywall)
          ? prev
          : [
              ...prev,
              {
                id: PAYWALL_MESSAGE_ID,
                trip_id: tripId,
                role: 'assistant' as const,
                content: copy.message,
                kind: 'ai' as const,
                changes_made: null,
                created_at: new Date().toISOString(),
                paywall: true,
              },
            ],
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [readonly, tripId, fetchEntitlement]);

  /**
   * Turn a pending assistant bubble into the paywall bubble.
   *
   * This is the mid-conversation case: the trial can expire between page load
   * and the next turn, so a send that was legal when the page rendered comes
   * back 402. The 402 body carries the machine-readable reason but not the copy
   * or the prices — those live on `/api/me/entitlement` so they can change
   * without a deploy — so re-ask, then rewrite the bubble in place. If that
   * second call fails too, the 402's own `error` string is still server-written
   * copy and beats inventing our own.
   */
  const showPaywallOnBubble = useCallback(
    async (assistantMsgId: string, body: Partial<PaywallErrorBody>) => {
      const payload = await fetchEntitlement();
      if (payload) setEntitlement(payload);
      const text = payload?.paywall?.message ?? body.error ?? '';
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? { ...m, content: text, streaming: false, applyError: null, paywall: true }
            : m,
        ),
      );
      // 'response', not 'error'. It is Penny answering, and the unread badge
      // should behave the way it does for anything else she says.
      onActivity?.('response');
    },
    [fetchEntitlement, onActivity],
  );

  /**
   * The fake-purchase path, for allowlisted accounts only.
   *
   * It exists because StoreKit returns an EMPTY product list until the Paid
   * Applications Agreement is active, so there is no real sheet to walk the
   * flow against. `testPurchaseAllowed` comes from the server and the route
   * re-checks the allowlist itself — this button existing proves nothing.
   */
  const runTestPurchase = useCallback(
    async (productId: string) => {
      setPurchasingId(productId);
      setPurchaseError(null);
      try {
        const res = await fetch('/api/purchase/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productId }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `Purchase failed (${res.status})`);
        }
        // The grant is only real once the entitlement endpoint agrees. Believing
        // the 200 would re-open the composer on our own say-so and hand the user
        // a second 402 on their next message.
        const fresh = await fetchEntitlement();
        if (!fresh?.entitled) {
          setPurchaseError(
            "That went through, but your plan hasn't switched on yet. Give it a moment and reload.",
          );
          return;
        }
        setEntitlement(fresh);
        setMessages((prev) => prev.filter((m) => !m.paywall));
        setPurchaseSheetOpen(false);
      } catch (e: unknown) {
        setPurchaseError(e instanceof Error ? e.message : String(e));
      } finally {
        setPurchasingId(null);
      }
    },
    [fetchEntitlement],
  );
  const [input, setInput] = useState('');
  // When an onboarding question arrives with a prefilled answer (e.g. a start
  // date we extracted from the trip description), drop it into the composer once
  // so the user confirms with a single keystroke. Keyed on question identity so
  // we don't clobber edits or re-fill after they clear it.
  const prefilledQuestionKey = useRef<string | null>(null);
  useEffect(() => {
    const q = onboardingQuestion;
    if (q?.defaultValue && prefilledQuestionKey.current !== q.key) {
      prefilledQuestionKey.current = q.key;
      setInput(q.defaultValue);
    }
  }, [onboardingQuestion]);
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [loading, setLoading] = useState(false);
  /**
   * True once a replan turn has been waiting long enough to justify the
   * friendly planning loader (video + copy) instead of the bare dots. Quick
   * edits resolve before the threshold and keep the lightweight dots.
   */
  /** True while Penny's intro typing animation plays (first visit only). */
  const [introTyping, setIntroTyping] = useState(false);
  /** Queue of messages sent while Penny is thinking — drained one-at-a-time. */
  const messageQueueRef = useRef<Array<{ text: string; images: AttachedImage[]; msgId: string }>>([]);
  const [dragOver, setDragOver] = useState(false);
  /** Nested dragenter/dragleave depth — avoids flicker over child elements. */
  const dragDepthRef = useRef(0);
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

  // While a turn is in flight but Penny hasn't streamed any text yet, show the
  // bare typing dots. (The dog-fetch clip for the first full build is now a
  // persistent transcript message, not a transient indicator.)
  const pennyStreamingText = messages.some(
    (m) =>
      m.id?.startsWith('optimistic-') &&
      m.role === 'assistant' &&
      m.streaming &&
      !!m.content,
  );
  const replanWaiting = loading && !pennyStreamingText;
  /*
   * Whether the identity strip reads THINKING or READY. Deliberately the SAME
   * expression the transcript's typing bubble uses (see its render below) plus
   * the streaming case — a strip that could say READY while three dots bounced
   * would be worse than no strip at all.
   */
  const pennyThinking = introTyping || replanWaiting || !!pennyStreamingText;

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

  /**
   * Apply a terminal `applied` payload to an assistant bubble — the single code
   * path shared by the live stream and the reconcile/heal flow, so a healed
   * turn renders identically to one seen live. Reloads the trip when something
   * changed.
   */
  const applyAppliedEvent = useCallback(
    (assistantMsgId: string, ev: AppliedEvent) => {
      const outcome = deriveApplyOutcome(ev);
      if (outcome.applyError && outcome.validationFailures.length > 0) {
        // Validation details are technical (Zod errors aimed at the LLM) — log,
        // don't surface.
        console.warn('[Penny] validation failures:', outcome.validationFailures);
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                content: ev.response || m.content,
                changes_made:
                  ev.appliedCount > 0
                    ? JSON.stringify(ev.changes ?? { changes: [] })
                    : null,
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
      onActivity?.(outcome.applyError ? 'error' : 'response');
    },
    [onTripUpdated, onActivity]
  );

  /** Put an assistant bubble into a stable error state (mirrors failAssistant). */
  const setBubbleError = useCallback((assistantMsgId: string, msg: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantMsgId
          ? { ...m, content: m.content || msg, streaming: false, applyError: m.content ? msg : null }
          : m
      )
    );
  }, []);

  /**
   * Re-attach to a turn's durable record and heal the bubble. Returns the
   * terminal disposition; callers poll while it's still `pending`. This is the
   * core of the "Something went wrong" fix: the server finished and recorded
   * the reply even when the client's stream threw, so on reopen we read it back
   * and replace the false error with Penny's real answer.
   */
  const reconcileTurn = useCallback(
    async (
      assistantMsgId: string,
      key: string
    ): Promise<'done' | 'error' | 'pending' | 'unknown'> => {
      try {
        const res = await fetch(
          `/api/trips/${tripId}/turns?key=${encodeURIComponent(key)}`
        );
        if (!res.ok) return 'unknown';
        const data = (await res.json().catch(() => null)) as { turn?: TurnRecord | null } | null;
        const turn = data?.turn ?? null;
        if (!turn) return 'unknown';
        if (turn.status === 'done') {
          if (turn.result_meta) {
            applyAppliedEvent(assistantMsgId, {
              ...turn.result_meta,
              response: turn.result_meta.response || turn.result_response || '',
            });
          } else if (turn.result_response) {
            // No structured meta (shouldn't happen) — at least show the prose.
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId
                  ? { ...m, content: turn.result_response as string, streaming: false }
                  : m
              )
            );
          }
          return 'done';
        }
        if (turn.status === 'error') {
          setBubbleError(
            assistantMsgId,
            turn.error_message
              ? `Error: ${turn.error_message}`
              : 'Something went wrong while updating your trip.'
          );
          onActivity?.('error');
          return 'error';
        }
        return 'pending';
      } catch {
        return 'unknown';
      }
    },
    [tripId, applyAppliedEvent, setBubbleError, onActivity]
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
    ): Promise<'done' | 'error' | 'timeout'> => {
      const deadline = Date.now() + (opts?.timeoutMs ?? 5 * 60 * 1000);
      let unknowns = 0;
      while (Date.now() < deadline) {
        const d = await reconcileTurn(assistantMsgId, key);
        if (d === 'done' || d === 'error') return d;
        if (d === 'unknown') {
          unknowns += 1;
          if (unknowns >= 3) return 'timeout';
        } else {
          unknowns = 0;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      return 'timeout';
    },
    [reconcileTurn]
  );

  // Reconcile on reopen/refocus — the user-facing core of the fix. When the PWA
  // comes back to the foreground, any assistant bubble still streaming or stuck
  // on a client-only error (with a known turn key) is re-checked against the
  // durable record: if Penny's turn landed while we were backgrounded, the false
  // error is silently replaced with her real reply.
  useEffect(() => {
    const reconcileOnOpen = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const candidates = messagesRef.current.filter(
        (m) => m.role === 'assistant' && !!m.turnKey && (m.streaming || !!m.applyError)
      );
      for (const m of candidates) {
        if (m.turnKey) void reconcileTurn(m.id, m.turnKey);
      }
    };
    document.addEventListener('visibilitychange', reconcileOnOpen);
    window.addEventListener('focus', reconcileOnOpen);
    return () => {
      document.removeEventListener('visibilitychange', reconcileOnOpen);
      window.removeEventListener('focus', reconcileOnOpen);
    };
  }, [reconcileTurn]);

  // Shared inner engine for "user said X → Penny replies". `sendMessage`
  // is the free-text composer path (pulls from input/images state); the
  // onboarding handoff calls `sendChatMessage` directly with the first
  // real user message right after the onboarding form finishes.
  //
  // Streams the response as Server-Sent Events so the user sees Penny's
  // paragraphs land live instead of waiting for the entire turn to buffer.
  // The terminal `applied` event carries the same shape as the old JSON
  // response — that's where we trigger onTripUpdated and the optional
  // fuel replenish.
  const sendChatMessage = async (
    trimmed: string,
    attachedImages: AttachedImage[] = [],
    /** When draining the queue, pass the existing optimistic message id to reuse it. */
    existingUserMsgId?: string,
    /**
     * Only true for the post-onboarding full-trip build: inserts the persistent
     * dog-fetch video bubble into the transcript so it stays (and keeps looping)
     * while Penny plans, rather than the old transient loader that vanished the
     * moment her response streamed in.
     */
    insertPlanningMedia = false,
  ): Promise<void> => {
    if (!trimmed && attachedImages.length === 0) return;

    const userMsgId = existingUserMsgId ?? `optimistic-${Date.now()}`;
    const assistantMsgId = `optimistic-${Date.now() + 1}`;
    // Stable id for this send: the idempotency anchor + the key the client uses
    // to re-attach and heal if the stream drops.
    const idempotencyKey = makeIdempotencyKey();

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
            turnKey: idempotencyKey,
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
        turnKey: idempotencyKey,
      };
      // The dog-fetch clip sits between the user's prompt and Penny's streaming
      // bubble, so the transcript reads: [their trip] → [Penny's video] → [plan].
      const planningMediaMsg: UIMessage | null = insertPlanningMedia
        ? {
            id: `penny-video-${Date.now() + 2}`,
            trip_id: tripId,
            role: 'assistant',
            content: PLANNING_VIDEO_COPY,
            kind: 'ai',
            changes_made: null,
            created_at: new Date().toISOString(),
            planningMedia: true,
          }
        : null;
      setMessages((prev) => [
        ...prev,
        tempUserMsg,
        ...(planningMediaMsg ? [planningMediaMsg] : []),
        pendingAssistantMsg,
      ]);
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
                applyError: m.content ? msg : null,
              }
            : m
        )
      );
    };

    /**
     * Beacon a client-only stream failure to the server so it lands in
     * /admin/errors, and return a short user-facing code. These failures
     * (the dominant one being the PWA backgrounded mid-turn, which tears down
     * the fetch) used to be a pure black hole: a generic string in React state,
     * `console.warn` only, nothing persisted. `keepalive` lets the beacon
     * survive the page being backgrounded/unloaded. Fire-and-forget — diagnostics
     * must never break the chat. NOTE: the SERVER already persists its own errors
     * (route.ts addChatMessage on the error branch), so we only beacon the
     * client-side paths it can't see.
     */
    const reportStreamError = (
      phase: 'stream-threw' | 'stream-incomplete',
      err?: unknown
    ): string => {
      const code = `S-${Math.random().toString(36).slice(2, 8)}`;
      const message =
        err instanceof Error ? err.message : err != null ? String(err) : undefined;
      const hidden =
        typeof document !== 'undefined' && document.visibilityState === 'hidden';
      try {
        void fetch('/api/analytics/client-error', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          body: JSON.stringify({
            tripId,
            code,
            phase,
            message: message?.slice(0, 500),
            hidden,
          }),
        }).catch(() => {});
      } catch {
        // never let diagnostics break the UI
      }
      return code;
    };

    // AppliedEvent + TurnRecord are declared at module scope (shared with the
    // reconcile/heal path).
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
          idempotencyKey,
        }),
      });

      if (!res.ok) {
        // Pre-stream errors (rate limit, validation, missing key) come back
        // as plain JSON like before.
        const data = await res.json().catch(() => ({}));

        // ...except 402, which is not a failure the user caused and must never
        // render as "Something went wrong". The trial can lapse between page
        // load and this turn, so a send that was legal when the composer
        // rendered comes back paywalled — Penny says so herself, in the bubble
        // that was about to hold her reply. Branch on the machine-readable
        // `code`, never on the message: the message is copy and copy changes.
        if (
          res.status === 402 &&
          (data as { code?: string }).code === PAYWALL_ERROR_CODE
        ) {
          setDeliveryStatus('responded');
          await showPaywallOnBubble(assistantMsgId, data as Partial<PaywallErrorBody>);
          return;
        }

        const errMsg = (data as { error?: string }).error ?? `Request failed (${res.status})`;
        setDeliveryStatus('responded');
        failAssistant(`Error: ${errMsg}`);
        onActivity?.('error');
        return;
      }

      // The server streams (text/event-stream) only when it runs this turn now.
      // It returns JSON instead when the turn was QUEUED behind another in-flight
      // turn, or when this exact send was already accepted (idempotent replay).
      // In those cases there's no live stream — apply the recorded result or poll
      // the durable record until it lands.
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        const data = (await res.json().catch(() => null)) as { turn?: TurnRecord | null } | null;
        const turn = data?.turn ?? null;
        if (!turn) {
          setDeliveryStatus('responded');
          failAssistant('Something went wrong starting that. Please try again.');
          onActivity?.('error');
          return;
        }
        setDeliveryStatus('delivered');
        if (turn.status === 'done' && turn.result_meta) {
          applyAppliedEvent(assistantMsgId, {
            ...turn.result_meta,
            response: turn.result_meta.response || turn.result_response || '',
          });
          setDeliveryStatus('responded');
          return;
        }
        if (turn.status === 'error') {
          setBubbleError(
            assistantMsgId,
            turn.error_message ? `Error: ${turn.error_message}` : 'Something went wrong.'
          );
          setDeliveryStatus('responded');
          onActivity?.('error');
          return;
        }
        // queued / running — Penny is busy with the prior turn; poll until ours
        // lands (it's drained by the in-flight request).
        setDeliveryStatus('read');
        const result = await pollTurnUntilTerminal(assistantMsgId, idempotencyKey);
        setDeliveryStatus('responded');
        if (result === 'timeout') {
          failAssistant(
            "Penny is taking longer than expected. Your message is saved — reopen the trip in a moment to see her reply."
          );
          onActivity?.('error');
        }
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
        // Stream ended without a terminal `applied` event. The server may still
        // have finished and recorded the turn (it doesn't stop when the client
        // drops), so reconcile from the durable record before declaring failure.
        const healed = await pollTurnUntilTerminal(assistantMsgId, idempotencyKey, {
          timeoutMs: 20000,
        });
        if (healed === 'done' || healed === 'error') {
          setDeliveryStatus('responded');
          return;
        }
        const code = reportStreamError('stream-incomplete');
        failAssistant(
          `Connection dropped before Penny finished (code ${code}). Your partial response is above; please retry.`
        );
        onActivity?.('error');
        return;
      }

      // Authoritative result from the server. `applyAppliedEvent` is the single
      // path shared with reconcile/heal, so a live turn and a healed one render
      // identically (and it reloads the trip when something changed).
      setDeliveryStatus('responded');
      applyAppliedEvent(assistantMsgId, appliedEvent);
    } catch (err) {
      console.warn('replan stream errored', err);
      // Almost always the PWA backgrounded mid-turn: the browser tears down the
      // fetch and `reader.read()` throws here. The server keeps running and
      // records Penny's reply regardless (no vercel.json → request cancellation
      // off), so reconcile from the durable turn record and HEAL the bubble
      // instead of dead-ending on "try again".
      const code = reportStreamError('stream-threw', err);
      setDeliveryStatus('responded');
      const healed = await pollTurnUntilTerminal(assistantMsgId, idempotencyKey, {
        timeoutMs: 20000,
      });
      if (healed !== 'done' && healed !== 'error') {
        // Couldn't confirm within the window — leave an accurate, non-alarming
        // message. The visibilitychange reconcile heals it on reopen if it lands.
        failAssistant(
          `Connection interrupted (code ${code}). Penny may still be finishing — reopen the trip in a moment to see her reply.`
        );
        onActivity?.('error');
      }
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
        // Surface any deterministic acknowledgment (e.g. the start-date confirm/
        // placeholder) as a Penny bubble before her real planning response.
        if (result.note) {
          setMessages((prev) => [
            ...prev,
            {
              id: `optimistic-${Date.now()}`,
              trip_id: tripId,
              role: 'assistant' as const,
              content: result.note as string,
              kind: 'ai' as const,
              changes_made: null,
              created_at: new Date().toISOString(),
            },
          ]);
        }
        // Fire the stored trip intent at Penny (not the last answer — that was a vehicle question)
        const intent = result.tripIntent ?? (typeof value === 'string' ? value : String(value));
        // This handoff turn is the full-trip build — the one wait we know will
        // be long. Pass insertPlanningMedia so Penny "sends" the dog-fetch clip
        // as a persistent transcript message (only here, never on later edits).
        await sendChatMessage(intent, [], undefined, true);
        onTripUpdated();
        // Re-focus the textarea so the keyboard stays open on mobile during
        // the transition from onboarding to normal chat.
        setTimeout(() => textareaRef.current?.focus(), 100);
      } else {
        const ts = Date.now();
        setMessages((prev) => {
          const additions: UIMessage[] = [
            {
              id: `optimistic-${ts}`,
              trip_id: tripId,
              role: 'user' as const,
              content: result.answerLabel,
              kind: 'form_answer' as const,
              changes_made: null,
              created_at: new Date().toISOString(),
            },
          ];
          // Append the deterministic Penny acknowledgment (e.g. start-date
          // confirm/placeholder) right after the user's answer.
          if (result.note) {
            additions.push({
              id: `optimistic-${ts + 1}`,
              trip_id: tripId,
              role: 'assistant' as const,
              content: result.note,
              kind: 'ai' as const,
              changes_made: null,
              created_at: new Date().toISOString(),
            });
          }
          return [...prev, ...additions];
        });
        setOnboardingSnapshot(result.next);
        setInput('');
      }
    } catch (e: unknown) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      // Show the user's answer and Penny's error as chat bubbles so the
      // conversation flow is visible, rather than just a tiny error label
      // near the composer that's easy to miss.
      const answerLabel = typeof value === 'string' ? value : String(value);
      setMessages((prev) => [
        ...prev,
        {
          id: `optimistic-${Date.now()}`,
          trip_id: tripId,
          role: 'user' as const,
          content: answerLabel,
          kind: 'form_answer' as const,
          changes_made: null,
          created_at: new Date().toISOString(),
        },
        {
          id: `optimistic-${Date.now() + 1}`,
          trip_id: tripId,
          role: 'assistant' as const,
          content: errorMsg,
          kind: 'ai' as const,
          changes_made: null,
          created_at: new Date().toISOString(),
        },
      ]);
      setInput('');
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
    /*
     * A `chips` step is answered EITHER by tapping a shortcut or by TYPING,
     * and this is the typed half. Without it a chips question fell through
     * this function and returned having done nothing: the composer accepted
     * the text, Enter appeared to work, and the answer was never submitted.
     * That is the exact case the kind exists for — "the second week of June"
     * is a valid start date and no chip can express it.
     *
     * Which validation applies is decided by whether the step carries BOUNDS.
     * The range question's 300/500/700 chips do (200–1500) and must be
     * treated as a number; the date question's phrases do not and are free
     * text. The bounds are also what produce the inline "Must be at least
     * 200" — the only place a driver learns the floor before the server
     * rejects them.
     */
    const numericChips =
      q.kind === 'chips' && (q.min !== undefined || q.max !== undefined);

    if (q.kind === 'text' || (q.kind === 'chips' && !numericChips)) {
      if (!trimmed) {
        setOnboardingError('This one is required.');
        return;
      }
      await submitOnboardingPost(q.key, trimmed);
      return;
    }
    if (q.kind === 'number' || q.kind === 'integer' || numericChips) {
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
    // Belt to the composer's braces. The textarea and send button are already
    // disabled behind the paywall; this catches a stray Enter on a focused
    // field so we can never fire a request whose only possible answer is a 402.
    if (paywalled) return;
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

  const resetDragOver = useCallback(() => {
    dragDepthRef.current = 0;
    setDragOver(false);
  }, []);

  useEffect(() => {
    if (isOnboarding) {
      setImages([]);
      resetDragOver();
    }
  }, [isOnboarding, resetDragOver]);

  useEffect(() => {
    const isOutsideViewport = (e: DragEvent) =>
      e.clientX <= 0 ||
      e.clientY <= 0 ||
      e.clientX >= window.innerWidth ||
      e.clientY >= window.innerHeight;

    const onDocumentDragLeave = (e: DragEvent) => {
      if (isOutsideViewport(e)) resetDragOver();
    };

    document.addEventListener('drop', resetDragOver);
    window.addEventListener('dragend', resetDragOver);
    document.addEventListener('dragleave', onDocumentDragLeave);
    window.addEventListener('blur', resetDragOver);

    return () => {
      document.removeEventListener('drop', resetDragOver);
      window.removeEventListener('dragend', resetDragOver);
      document.removeEventListener('dragleave', onDocumentDragLeave);
      window.removeEventListener('blur', resetDragOver);
    };
  }, [resetDragOver]);

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (isOnboarding) return;
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragDepthRef.current += 1;
    setDragOver(true);
  };

  const handleDragLeave = () => {
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setDragOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    resetDragOver();
    if (isOnboarding) return;
    if (e.dataTransfer?.files?.length) {
      addImageFiles(e.dataTransfer.files);
    }
  };

  const onboardingComposerBusy = onboardingUiActive && (onboardingLoading || onboardingSubmitting);

  // For the disabled prop we only include the *loading* states (initial fetch)
  // — not the *submitting* states. Disabling the textarea during submit blurs
  // it, which closes the mobile keyboard and breaks the back-and-forth chat
  // feel. Double-submit is already guarded by early-returns in sendMessage /
  // submitOnboardingTextAnswer.
  const onboardingComposerDisabled = onboardingUiActive && (onboardingLoading || introTyping);

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
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

      {/*
        Penny's identity strip. The avatar was a two-hue gradient
        (primary → success) — under the mono palette those are now the same
        colour, so it is a ring with a soft glow instead, which is also what
        distinguishes it from the account avatar in the header above.

        The status on the right is the ONLY place the panel says whether Penny
        is working. It replaces nothing — before this you had to notice the
        typing dots appear in the transcript.
      */}
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
            width: 34,
            height: 34,
            borderRadius: '50%',
            background: 'var(--tp-accent-900)',
            border: '1px solid var(--tp-primary)',
            boxShadow: '0 0 12px rgba(145, 132, 217, 0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--tp-accent-300)',
            fontWeight: 600,
            fontSize: 14,
            flexShrink: 0,
          }}
        >
          P
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--tp-text)', lineHeight: 1.1 }}>
            Penny
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--tp-subtle)',
              letterSpacing: '0.02em',
              marginTop: 2,
            }}
          >
            Feral Travels AI · plans your days
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexShrink: 0,
            fontSize: 9.5,
            fontWeight: 600,
            letterSpacing: '0.13em',
            color: pennyThinking ? 'var(--tp-accent-300)' : 'var(--tp-subtle)',
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: pennyThinking ? 'var(--tp-accent-300)' : 'var(--tp-primary)',
              // Same timing as the transcript's typing dots, so the two read
              // as one state rather than two things happening.
              animation: pennyThinking ? 'tp-pulse 1.2s ease-in-out infinite' : undefined,
            }}
          />
          {pennyThinking ? 'THINKING' : 'READY'}
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
        {/*
          The empty state. It was a bare <div /> — a chat panel with nothing in
          it and no indication of what to type, which is the moment a new user
          decides whether this app does anything.

          The rows PREFILL the composer and focus it rather than sending: the
          examples are shapes to edit, not messages anyone actually wants to
          send verbatim. Same channel `+ Add to this day` uses.
        */}
        {messages.length === 0 && !onboardingUiActive && (
          <div style={{ padding: '4px 0 12px' }}>
            <div
              style={{
                fontSize: 9.5,
                fontWeight: 600,
                letterSpacing: '0.13em',
                color: 'var(--tp-subtle)',
                marginBottom: 8,
              }}
            >
              START HERE
            </div>
            <div
              style={{
                fontSize: 19,
                fontWeight: 500,
                lineHeight: 1.3,
                color: 'var(--tp-text)',
                textWrap: 'pretty',
                marginBottom: 16,
              }}
            >
              Tell Penny where you&apos;re going and how far you want to drive each day.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {CHAT_STARTERS.map((starter) => (
                <button
                  key={starter}
                  type="button"
                  onClick={() => {
                    setInput(starter);
                    textareaRef.current?.focus();
                  }}
                  style={{
                    ...buttonStyle('secondary'),
                    justifyContent: 'flex-start',
                    textAlign: 'left',
                    padding: '12px 14px',
                    fontSize: 13.5,
                    fontWeight: 400,
                    color: 'var(--tp-muted)',
                  }}
                >
                  &ldquo;{starter}&rdquo;
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, msgIdx) => {
          // Hide the empty assistant bubble while Penny is working but hasn't
          // emitted any text yet — the 3-dot typing indicator covers this
          // state. Without this, a streaming-but-textless bubble would render
          // as an empty bubble above the typing dots.
          if (msg.role === 'assistant' && msg.streaming && !msg.content) {
            return null;
          }
          const gp = getGroupPosition(messages, msgIdx);
          // Tight 2px gap inside a group, 10px between groups.
          const marginTop = msgIdx === 0 ? 0 : gp.isFirst ? 10 : 2;
          // The dog-fetch clip Penny "sends" on the first full build: a caption
          // bubble + a persistent looping video bubble. Rendered like a real
          // iMessage video message so it stays in the transcript (scrollable).
          if (msg.planningMedia) {
            return (
              <div
                key={msg.id}
                style={{
                  maxWidth: '80%',
                  alignSelf: 'flex-start',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 6,
                  marginTop,
                }}
              >
                {msg.content && <div className="penny-planning-copy">{msg.content}</div>}
                <PennyPlanningVideo />
              </div>
            );
          }
          const isQueued = msg.deliveryStatus === 'queued';
          return (
          <div
            key={msg.id}
            data-testid="chat-message"
            data-message-role={msg.role}
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
              // pre-wrap wraps at whitespace but can't break an unbroken token
              // (e.g. a long pasted URL with no spaces) — overflowWrap lets the
              // bubble break inside such tokens so they stay within maxWidth.
              overflowWrap: 'anywhere',
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
            {msg.paywall ? <PaywallText text={msg.content} /> : msg.content}
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
            {msg.plan_summary && !msg.applyError && (
              <PlanSummaryCard summary={msg.plan_summary} units={units} />
            )}
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
                  She hit her planning step limit mid-plan and saved partial work. Click below to keep going from where she stopped.
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
            {/* The paywall's action, inside Penny's bubble — the same shape as
                the truncated card's "Continue planning": her words, then the
                one thing to do about them. The label is the server's, so the
                button says "Renew" or "Email support" without this file
                knowing which. It renders only once we hold the payload; if the
                entitlement call failed we still show her message and simply
                have no prices to offer. */}
            {msg.paywall && entitlement?.paywall && (
              <div style={{ marginTop: 10 }}>
                {paywallSupportOnly ? (
                  <a
                    data-testid="paywall-support-link"
                    href={`mailto:${SUPPORT_EMAIL}`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      padding: '7px 14px',
                      borderRadius: 8,
                      fontSize: 12,
                      fontWeight: 600,
                      textDecoration: 'none',
                      background: 'transparent',
                      color: 'var(--tp-primary)',
                      border: '1px solid var(--tp-border-strong)',
                    }}
                  >
                    {entitlement.paywall.buttonLabel}
                  </a>
                ) : (
                  <button
                    data-testid="paywall-cta"
                    onClick={() => {
                      setPurchaseError(null);
                      setPurchaseSheetOpen(true);
                    }}
                    style={{
                      ...buttonStyle(),
                      padding: '7px 14px',
                      fontSize: 12,
                      letterSpacing: '0.02em',
                    }}
                  >
                    {entitlement.paywall.buttonLabel}
                  </button>
                )}
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
              {/* No "Penny is typing…" text — the 3-dot bubble is the typing
                  indicator (iMessage-style). Keep the receipt on "Read" so it
                  doesn't flicker away while she types/streams. */}
              {msg.deliveryStatus === 'typing' && (
                <span style={{ color: 'var(--tp-muted)' }}>Read</span>
              )}
              {msg.deliveryStatus === 'responded' && (
                <span style={{ color: 'var(--tp-muted)' }}>Read</span>
              )}
            </div>
          )}
          </div>
          );
        })}

        {/* Typing indicator — shown when Penny has "read" the message but
            hasn't started responding yet (no text chunks received), or during
            the typing animation before each onboarding question. The dog-fetch
            clip for the first full build is a persistent message above, not part
            of this transient indicator. */}
        {(introTyping || replanWaiting) && (
          <div className="typing-indicator-bubble" aria-label="Penny is typing">
            <span className="typing-indicator-dot" />
            <span className="typing-indicator-dot" />
            <span className="typing-indicator-dot" />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Attachment thumbnails */}
      {images.length > 0 && !isOnboarding && (
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
                (onboardingQuestion?.kind === 'select' ||
                  onboardingQuestion?.kind === 'chips') &&
                onboardingQuestion.options && (
                  <div
                    style={{
                      padding: '10px 16px 10px',
                      flexShrink: 0,
                      borderTop: '1px solid var(--tp-border)',
                      background: 'var(--tp-surface-muted)',
                    }}
                  >
                    {/* Only for 'select', where tapping is the ONLY way to
                        answer. On a 'chips' step the composer is live, so
                        telling the user to tap would be wrong. */}
                    {onboardingQuestion.kind === 'select' && (
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
                    )}
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
                    {onboardingQuestion.footnote && (
                      <div
                        style={{
                          fontSize: 11,
                          color: 'var(--tp-subtle)',
                          marginTop: 8,
                          lineHeight: 1.45,
                        }}
                      >
                        {onboardingQuestion.footnote}
                      </div>
                    )}
                  </div>
                )}

              {/*
                PROMPT ROWS. These PREFILL the composer and focus it — they do
                not submit, which is the whole difference between them and the
                chips above. An option is an answer to this question; a prompt
                is a shape to edit, and nobody wants their first message sent
                verbatim.
              */}
              {onboardingUiActive && onboardingQuestion?.prompts?.length ? (
                <div
                  style={{
                    padding: '10px 16px',
                    flexShrink: 0,
                    borderTop: '1px solid var(--tp-border)',
                    background: 'var(--tp-surface-muted)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  {onboardingQuestion.prompts.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      disabled={onboardingComposerBusy}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setInput(prompt);
                        textareaRef.current?.focus();
                      }}
                      style={{
                        ...buttonStyle('secondary'),
                        justifyContent: 'flex-start',
                        textAlign: 'left',
                        padding: '11px 14px',
                        fontSize: 13.5,
                        fontWeight: 400,
                        color: 'var(--tp-muted)',
                        opacity: onboardingComposerBusy ? 0.5 : 1,
                      }}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              ) : null}
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
            <PaperclipIcon />
          </button>
          )}
          <textarea
            ref={textareaRef}
            data-testid="trip-chat-composer"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            readOnly={Boolean(onboardingSelectStep)}
            enterKeyHint="send"
            onFocus={() => {
              if (onboardingUiActive) return;
              // Scroll the messages container to bottom when the textarea
              // gets focus — keeps the latest messages visible above the
              // keyboard. We use scrollToBottom (scrollTop-based) instead of
              // scrollIntoView to avoid iOS Safari dismissing the keyboard.
              setTimeout(() => scrollToBottom(), 250);
            }}
            placeholder={
              // Deliberately points AT Penny's message rather than restating
              // it — there is exactly one authoritative wording for why this is
              // closed, and it is in the bubble above, written by the server.
              paywalled
                ? "See Penny's message above"
                : onboardingSelectStep
                  ? 'Tap an option above…'
                  : onboardingUiActive && onboardingQuestion
                    ? onboardingQuestion.placeholder ?? 'Type your answer…'
                    : 'Ask Penny…'
            }
            disabled={onboardingComposerDisabled || paywalled}
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
                paywalled ||
                  onboardingComposerBusy ||
                  (!onboardingUiActive &&
                    !input.trim() &&
                    images.length === 0) ||
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
                ((!onboardingUiActive &&
                  (input.trim() || images.length > 0)) ||
                  (onboardingUiActive &&
                    onboardingQuestion &&
                    !onboardingSelectStep &&
                    input.trim())) &&
                !onboardingComposerBusy &&
                !paywalled
                  ? 'var(--tp-primary)'
                  : 'var(--tp-border)',
              border: 'none',
              borderRadius: '50%',
              color:
                ((!onboardingUiActive &&
                  (input.trim() || images.length > 0)) ||
                  (onboardingUiActive &&
                    onboardingQuestion &&
                    !onboardingSelectStep &&
                    input.trim())) &&
                !onboardingComposerBusy &&
                !paywalled
                  ? 'var(--tp-on-primary)'
                  : 'var(--tp-subtle)',
              cursor:
                ((!onboardingUiActive &&
                  (input.trim() || images.length > 0)) ||
                  (onboardingUiActive &&
                    onboardingQuestion &&
                    !onboardingSelectStep &&
                    input.trim())) &&
                !onboardingComposerBusy &&
                !paywalled
                  ? 'pointer'
                  : 'default',
              transition: 'background 0.15s, color 0.15s',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <SendArrowIcon />
          </button>
        </div>
      </div>
            </>
          )}
        </>
      )}

      {/* The one modal in this flow, and only when there is something to sell.
          A capped or revoked account never reaches it — that button is a
          mailto. */}
      {purchaseSheetOpen && entitlement && !paywallSupportOnly && (
        <PurchaseSheet
          products={entitlement.products}
          testPurchaseAllowed={entitlement.testPurchaseAllowed}
          purchasingId={purchasingId}
          error={purchaseError}
          onPurchase={(productId) => void runTestPurchase(productId)}
          // The sheet has already confirmed entitlement with the server before
          // calling this; what is left is to bring THIS component's state in
          // line — same three updates the purchase path makes. No reload: the
          // transcript is client state and an in-flight stream would die with
          // it, which is the whole reason the paywall is a message and not a
          // page-level block.
          onRedeemed={() => {
            void (async () => {
              const fresh = await fetchEntitlement();
              if (fresh) setEntitlement(fresh);
              setMessages((prev) => prev.filter((m) => !m.paywall));
              setPurchaseSheetOpen(false);
            })();
          }}
          onClose={() => setPurchaseSheetOpen(false)}
        />
      )}
    </div>
  );
}
