'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { ChatMessage, OnboardingState } from '@/types/trip';
import { tripApi, apiFetch } from '@/lib/api';
import OnboardingForm from '@/components/OnboardingForm';

interface ChatPanelProps {
  tripId: number;
  initialMessages: ChatMessage[];
  initialHasMore?: boolean;
  /**
   * When not 'done', the composer is replaced by the OnboardingForm which
   * walks the user through picking/creating a vehicle before Penny takes over.
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

interface UIMessage extends ChatMessage {
  imageDataUrls?: string[];
  // Populated when Penny proposed changes but the server couldn't apply them
  // (unknown action, owner mismatch, DB error). We surface this so the user
  // doesn't see a misleading "Changes applied to trip" badge.
  applyError?: string | null;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export default function ChatPanel({
  tripId,
  initialMessages,
  initialHasMore = false,
  onboardingState = 'done',
  onTripUpdated,
  onActivity,
  readonly = false,
}: ChatPanelProps) {
  const isOnboarding = onboardingState !== 'done' && !readonly;
  const [messages, setMessages] = useState<UIMessage[]>(initialMessages);
  const [input, setInput] = useState('');
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [loading, setLoading] = useState(false);
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
  // smooth-scroll on every subsequent new message or loading toggle. We only
  // snap instantly the first time because smooth-scrolling on first mount
  // visibly "falls" the chat in which looks janky.
  useEffect(() => {
    if (!didInitialScroll.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
      didInitialScroll.current = true;
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, loading]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMore || messages.length === 0) return;
    // Optimistic messages have `Date.now()` ids (13-digit ms timestamps) which
    // are always higher than any real DB id, so we walk up from the front to
    // find the earliest persisted id — that's our "before" cursor.
    const earliest = messages.find((m) => m.id < 1_000_000_000_000);
    if (!earliest) return;
    setLoadingOlder(true);
    const scrollEl = scrollRef.current;
    pendingRestoreScroll.current = scrollEl
      ? { prevHeight: scrollEl.scrollHeight }
      : null;
    try {
      const data = await apiFetch<{ messages: ChatMessage[]; hasMore: boolean }>(
        `/api/chat`,
        { query: { tripId, before: earliest.id } }
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
  const sendChatMessage = async (
    trimmed: string,
    attachedImages: AttachedImage[] = []
  ): Promise<void> => {
    if ((!trimmed && attachedImages.length === 0) || loading) return;

    const tempUserMsg: UIMessage = {
      id: Date.now(),
      trip_id: tripId,
      role: 'user',
      content: trimmed,
      kind: 'ai',
      changes_made: null,
      created_at: new Date().toISOString(),
      imageDataUrls: attachedImages.map((i) => i.dataUrl),
    };
    setMessages((prev) => [...prev, tempUserMsg]);
    setLoading(true);
    onActivity?.('thinking');

    try {
      const data: any = await tripApi(tripId).replan(
        trimmed,
        attachedImages.map((i) => ({ dataUrl: i.dataUrl, mediaType: i.mediaType }))
      );

      if (data?.error) {
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now() + 1,
            trip_id: tripId,
            role: 'assistant',
            content: `Error: ${data.error}`,
            kind: 'ai',
            changes_made: null,
            created_at: new Date().toISOString(),
          },
        ]);
        onActivity?.('error');
      } else {
        const appliedCount: number = typeof data?.appliedCount === 'number' ? data.appliedCount : 0;
        const failedCount: number = typeof data?.failedCount === 'number' ? data.failedCount : 0;
        const hadProposedChanges = Array.isArray(data?.changes?.changes)
          ? data.changes.changes.length > 0
          : false;
        const fuelReplenishQueued: boolean = data?.fuelReplenishQueued === true;
        let applyError: string | null = null;
        if (hadProposedChanges && appliedCount === 0) {
          applyError =
            'Penny proposed changes but nothing was saved. Re-ask her with more detail (e.g. starting point, destination).';
        } else if (failedCount > 0 && Array.isArray(data?.failedActions)) {
          applyError = `Some changes failed: ${data.failedActions
            .map((f: any) => f.action)
            .join(', ')}`;
        }
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now() + 1,
            trip_id: tripId,
            role: 'assistant',
            content: data.response,
            kind: 'ai',
            // Only keep changes_made when something was actually applied, so
            // the "Changes applied to trip" pill is truthful.
            changes_made: appliedCount > 0 && data.changes ? JSON.stringify(data.changes) : null,
            created_at: new Date().toISOString(),
            applyError,
          },
        ]);
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
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          trip_id: tripId,
          role: 'assistant',
          content: 'Failed to reach the server. Check that your ANTHROPIC_API_KEY is set.',
          kind: 'ai',
          changes_made: null,
          created_at: new Date().toISOString(),
        },
      ]);
      onActivity?.('error');
    } finally {
      setLoading(false);
    }
  };

  // Thin wrapper — the composer path pulls text/images out of local state,
  // clears them, and delegates to the shared engine. Onboarding handoff
  // sidesteps this and calls sendChatMessage directly.
  const sendMessage = async () => {
    const trimmed = input.trim();
    const attachedImages = images;
    if ((!trimmed && attachedImages.length === 0) || loading) return;
    setInput('');
    setImages([]);
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
    if (files.length) {
      e.preventDefault();
      addImageFiles(files);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) {
      addImageFiles(e.dataTransfer.files);
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer?.types?.includes('Files')) setDragOver(true);
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
      {dragOver && (
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
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          WebkitOverflowScrolling: 'touch',
        }}
      >
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
          <div style={{ color: 'var(--tp-muted)', fontSize: 13, textAlign: 'center', marginTop: 40 }}>
            Ask Penny to modify your trip plan. For example:
            <br />
            <em>&quot;Move the Nürburgring day to after Denmark&quot;</em>
            <br />
            <em>&quot;Plan fuel stops for the drive to Trondheim&quot;</em>
            <br />
            <em>&quot;Add a rest day in Hamburg&quot;</em>
            <br />
            <span style={{ fontSize: 11, color: 'var(--tp-subtle)' }}>
              Drag, paste, or click 📎 to attach a screenshot.
            </span>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              maxWidth: '85%',
              alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
              padding: '10px 14px',
              borderRadius: 10,
              background: msg.role === 'user' ? 'var(--tp-primary-muted)' : 'var(--tp-surface)',
              border: `1px solid ${msg.role === 'user' ? 'rgba(78, 122, 176, 0.28)' : 'var(--tp-border)'}`,
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
          </div>
        ))}

        {loading && (
          <div
            style={{
              alignSelf: 'flex-start',
              padding: '10px 14px',
              borderRadius: 10,
              background: 'var(--tp-surface-muted)',
              border: '1px solid var(--tp-border)',
              fontSize: 14,
              color: 'var(--tp-muted)',
            }}
          >
            Thinking...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Attachment thumbnails */}
      {images.length > 0 && (
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
      ) : isOnboarding ? (
        <OnboardingForm
          tripId={tripId}
          initialState={onboardingState}
          onAnswer={(userLabel, questionLabel) => {
            // Mirror the Q/A pair as optimistic bubbles so the chat surface
            // feels alive even though the real rows are written server-side.
            // We give assistant the question, user the answer — same order
            // as the server writes them so the replay after router.refresh
            // doesn't look any different.
            setMessages((prev) => [
              ...prev,
              {
                id: Date.now(),
                trip_id: tripId,
                role: 'assistant',
                content: questionLabel,
                kind: 'form_question',
                changes_made: null,
                created_at: new Date().toISOString(),
              },
              {
                id: Date.now() + 1,
                trip_id: tripId,
                role: 'user',
                content: userLabel,
                kind: 'form_answer',
                changes_made: null,
                created_at: new Date().toISOString(),
              },
            ]);
          }}
          onHandoff={async (handoffText) => {
            // Fire the real Penny call with the user's free-text answer, then
            // bounce the server so TripWorkspace picks up onboarding_state='done'
            // and any legs Penny created.
            await sendChatMessage(handoffText, []);
            onTripUpdated();
          }}
        />
      ) : (
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
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 6,
            background: 'var(--tp-surface)',
            border: '1px solid var(--tp-border)',
            borderRadius: 12,
            padding: 6,
            transition: 'border-color 0.15s',
          }}
        >
          <button
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
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={(e) => {
              // iOS Safari slides the soft keyboard up over absolutely-positioned
              // bottom UI; nudge the textarea into view after the keyboard
              // animation has settled (~250ms) so the user sees what they type.
              const el = e.currentTarget;
              setTimeout(() => {
                try {
                  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                } catch {
                  /* ignore — older Safari throws on smooth */
                }
              }, 250);
            }}
            placeholder="Ask Penny…"
            disabled={loading}
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
            onClick={sendMessage}
            disabled={loading || (!input.trim() && images.length === 0)}
            aria-label="Send"
            title="Send"
            style={{
              width: 32,
              height: 32,
              flexShrink: 0,
              padding: 0,
              background: input.trim() || images.length > 0 ? 'var(--tp-primary)' : 'var(--tp-border)',
              border: 'none',
              borderRadius: 8,
              color: input.trim() || images.length > 0 ? 'var(--tp-on-primary)' : 'var(--tp-subtle)',
              cursor: input.trim() || images.length > 0 ? 'pointer' : 'default',
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
        <div
          style={{
            marginTop: 6,
            fontSize: 10,
            color: 'var(--tp-subtle)',
            
            letterSpacing: '0.04em',
            textAlign: 'center',
          }}
        >
          Enter to send · Shift+Enter for newline · drag/paste to attach
        </div>
      </div>
      )}
    </div>
  );
}
