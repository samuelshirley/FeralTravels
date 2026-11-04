'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/api';
import {
  optimisticVote,
  voteFailure,
  votingOpen,
  type FeatureRequestView,
  type VoteResult,
} from '@/lib/featureRequests';

/**
 * Feature requests on the web: the same list, rules and copy as the iOS
 * screen (mobile/app/feature-requests.tsx). Order comes from the server and is
 * never re-sorted after a vote, so a card does not move under the cursor.
 *
 * Voting is optimistic. Only the answer to the LATEST click on a request is
 * drawn; a failure puts back the last count the server confirmed and says why
 * (voteFailure, shared with iOS) — inline, never silently.
 */
export default function FeatureRequestsBoard({ initialRows }: { initialRows: FeatureRequestView[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [message, setMessage] = useState<string | null>(null);
  const confirmed = useRef(
    new Map<string, VoteResult>(initialRows.map((r) => [r.id, { voteCount: r.voteCount, votedByMe: r.votedByMe }])),
  );
  const seq = useRef(new Map<string, number>());

  const patch = useCallback((id: string, next: VoteResult) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...next } : r)));
  }, []);

  const reload = useCallback(async () => {
    try {
      const res = await apiFetch<{ requests: FeatureRequestView[] }>('/api/feature-requests', {
        skipGlobalErrorReport: true,
      });
      confirmed.current = new Map(
        res.requests.map((r) => [r.id, { voteCount: r.voteCount, votedByMe: r.votedByMe }]),
      );
      setRows(res.requests);
    } catch {
      setMessage('The list did not reload. Refresh the page to see the latest.');
    }
  }, []);

  const vote = useCallback(
    async (row: FeatureRequestView, next: boolean) => {
      if (!votingOpen(row.status)) return;
      const mine = (seq.current.get(row.id) ?? 0) + 1;
      seq.current.set(row.id, mine);
      setMessage(null);
      patch(row.id, optimisticVote(row, next));
      try {
        const result = await apiFetch<VoteResult>(`/api/feature-requests/${row.id}/vote`, {
          method: next ? 'PUT' : 'DELETE',
          skipGlobalErrorReport: true,
        });
        confirmed.current.set(row.id, result);
        if (seq.current.get(row.id) === mine) patch(row.id, result);
      } catch (err) {
        if (seq.current.get(row.id) !== mine) return;
        const back = confirmed.current.get(row.id);
        if (back) patch(row.id, back);
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
          return;
        }
        const failure =
          err instanceof ApiError && err.status > 0
            ? voteFailure(err.status, err.message)
            : voteFailure(null, null);
        setMessage(failure.message);
        if (failure.reload) void reload();
      }
    },
    [patch, reload, router],
  );

  const active = rows.filter((r) => votingOpen(r.status));
  const closed = rows.filter((r) => !votingOpen(r.status));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="feature-requests-list">
      <style>{`
        @keyframes ftTyping { 0%,60%,100% { opacity:.35; transform:translateY(0) } 30% { opacity:1; transform:translateY(-2px) } }
        .ft-dot { width:5px; height:5px; border-radius:3px; background:var(--tp-accent-300); display:inline-block; animation:ftTyping 1.2s infinite ease-in-out }
        .ft-dot:nth-child(2) { animation-delay:.15s } .ft-dot:nth-child(3) { animation-delay:.3s }
        @media (prefers-reduced-motion: reduce) { .ft-dot { animation:none; opacity:.8 } }
      `}</style>
      {message ? (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--tp-danger)' }}>
          {message}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p style={{ margin: 0, fontSize: 14, color: 'var(--tp-muted)', textAlign: 'center' }}>
          No feature requests yet.
        </p>
      ) : null}
      {active.map((r) => (
        <Card key={r.id} row={r} onVote={(v) => void vote(r, v)} />
      ))}
      {closed.length > 0 ? (
        <>
          <div
            style={{ marginTop: 14, fontSize: 9.5, fontWeight: 600, letterSpacing: '0.8px', color: 'var(--tp-subtle)' }}
          >
            NOT DOING
          </div>
          {closed.map((r) => (
            <Card key={r.id} row={r} onVote={() => {}} />
          ))}
        </>
      ) : null}
    </div>
  );
}

function Card({ row, onVote }: { row: FeatureRequestView; onVote: (vote: boolean) => void }) {
  const open = votingOpen(row.status);
  const inProgress = row.status === 'in_progress';
  const voted = row.votedByMe;
  const countLabel = `${row.voteCount} ${row.voteCount === 1 ? 'vote' : 'votes'}`;
  const chevron = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 15l6-6 6 6" />
    </svg>
  );
  return (
    <article
      data-testid={`feature-request-${row.id}`}
      style={{
        position: 'relative',
        display: 'flex',
        gap: 12,
        background: open ? 'var(--tp-surface)' : 'var(--tp-surface-muted)',
        border: '1px solid var(--tp-border)',
        borderRadius: 'var(--tp-radius-md, 8px)',
        padding: `14px 14px ${inProgress ? 44 : 14}px 10px`,
      }}
    >
      {open ? (
        <button
          type="button"
          onClick={() => onVote(!voted)}
          aria-pressed={voted}
          aria-label={voted ? `Remove your vote. ${countLabel}` : `Vote. ${countLabel}`}
          data-testid={`feature-request-vote-${row.id}`}
          style={{
            flex: 'none',
            width: 44,
            height: 52,
            borderRadius: 8,
            border: `1px solid ${voted ? 'var(--tp-primary)' : 'transparent'}`,
            background: voted ? 'var(--tp-primary-muted)' : 'transparent',
            color: voted ? 'var(--tp-accent-400)' : 'var(--tp-muted)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
            cursor: 'pointer',
            fontFamily: 'inherit',
            padding: 0,
          }}
        >
          {chevron}
          <span style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{row.voteCount}</span>
        </button>
      ) : (
        <div
          role="img"
          aria-label={`${countLabel}. Voting closed`}
          data-testid={`feature-request-closed-${row.id}`}
          style={{
            flex: 'none',
            width: 44,
            height: 52,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
            color: 'var(--tp-subtle)',
          }}
        >
          {chevron}
          <span style={{ fontSize: 13, fontWeight: 600 }}>{row.voteCount}</span>
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 500, lineHeight: 1.3, color: open ? 'var(--tp-text)' : 'var(--tp-muted)' }}>
          {row.title}
        </h2>
        {row.body ? <p style={{ margin: 0, fontSize: 13, lineHeight: 1.45, color: 'var(--tp-muted)' }}>{row.body}</p> : null}
        {row.reply ? (
          <div
            style={{
              marginTop: 8,
              background: open ? 'var(--tp-surface-muted)' : 'var(--tp-bg)',
              border: '1px solid var(--tp-neutral-900)',
              borderRadius: 8,
              padding: '9px 11px',
            }}
          >
            <div style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '0.8px', color: 'var(--tp-accent-400)' }}>
              SAM · FERAL TRAVELS
            </div>
            <p style={{ margin: '3px 0 0', fontSize: 12.5, lineHeight: 1.45, color: open ? 'var(--tp-text)' : 'var(--tp-muted)' }}>
              {row.reply}
            </p>
          </div>
        ) : null}
      </div>
      {inProgress ? (
        <div
          role="img"
          aria-label="In progress"
          data-testid={`feature-request-in-progress-${row.id}`}
          style={{ position: 'absolute', right: 10, bottom: 10, display: 'flex', alignItems: 'center', gap: 7 }}
        >
          <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.2px', color: 'var(--tp-accent-300)' }}>
            In progress
          </span>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              background: 'var(--tp-accent-900)',
              borderRadius: 12,
              padding: '7px 10px',
            }}
          >
            <span className="ft-dot" />
            <span className="ft-dot" />
            <span className="ft-dot" />
          </span>
        </div>
      ) : null}
    </article>
  );
}
