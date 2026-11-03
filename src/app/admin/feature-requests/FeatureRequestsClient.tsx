'use client';

import { useState } from 'react';
import {
  FEATURE_REQUEST_BODY_MAX,
  FEATURE_REQUEST_REPLY_MAX,
  FEATURE_REQUEST_TITLE_MAX,
  type FeatureRequestStatus,
} from '@/lib/featureRequests';

/**
 * The admin side of feature requests: add one, filter by status, set a
 * status, reply (shown under the request in the app; on a Not doing request it
 * is the reason), delete. Every change re-reads the list from the server, so
 * the order and counts shown are the server's — the same order the app shows.
 *
 * Errors are inline, next to the control that failed — never an alert and
 * never silent.
 */
export interface AdminFeatureRequestRow {
  id: string;
  title: string;
  body: string | null;
  status: FeatureRequestStatus;
  reply: string | null;
  voteCount: number;
  createdAt: string;
  updatedAt: string;
}

type Filter = 'all' | FeatureRequestStatus;

const STATUS_LABEL: Record<FeatureRequestStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  not_doing: 'Not doing',
};
const STATUSES: FeatureRequestStatus[] = ['open', 'in_progress', 'not_doing'];

const card: React.CSSProperties = {
  background: 'var(--tp-surface)',
  border: '1px solid var(--tp-border)',
  borderRadius: 10,
  padding: 16,
  boxShadow: 'var(--tp-shadow-sm)',
};

const kicker: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.15em',
  color: 'var(--tp-subtle)',
};

const fieldLabel: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  color: 'var(--tp-muted)',
};

const input: React.CSSProperties = {
  background: 'var(--tp-bg)',
  border: '1px solid var(--tp-border)',
  borderRadius: 8,
  padding: '10px 12px',
  color: 'var(--tp-text)',
  fontSize: 14,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
  width: '100%',
};

const primaryBtn: React.CSSProperties = {
  padding: '8px 16px',
  borderRadius: 8,
  border: 0,
  background: 'var(--tp-primary)',
  color: 'var(--tp-on-primary)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

const quietBtn: React.CSSProperties = {
  padding: '7px 12px',
  borderRadius: 8,
  border: '1px solid var(--tp-border)',
  background: 'transparent',
  color: 'var(--tp-muted)',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};

const errorText: React.CSSProperties = { fontSize: 12, color: 'var(--tp-danger)', margin: 0 };

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Throws with the server's error code (or the status) when the response is not OK. */
async function checked(res: Response): Promise<void> {
  if (res.ok) return;
  let message = `HTTP ${res.status}`;
  try {
    const data = (await res.json()) as { error?: unknown };
    if (typeof data.error === 'string') message = `${data.error} (HTTP ${res.status})`;
  } catch {
    // Not JSON — the status is all there is.
  }
  throw new Error(message);
}

/*
 * Each call names its path literally in `fetch(`: adminEndpointCallerGuard
 * counts an admin route as having a control only that way.
 */
async function patchRequest(id: string, body: unknown): Promise<void> {
  await checked(
    await fetch(`/api/admin/feature-requests/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function deleteRequest(id: string): Promise<void> {
  await checked(await fetch(`/api/admin/feature-requests/${id}`, { method: 'DELETE' }));
}

export default function FeatureRequestsClient({ initialRows }: { initialRows: AdminFeatureRequestRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [filter, setFilter] = useState<Filter>('all');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [reloadError, setReloadError] = useState(false);

  /**
   * Re-read after every change. `rows` is local state seeded once from the
   * server render, so `router.refresh()` would not update it. A failed
   * re-read is said, or the change just made looks like it never happened.
   */
  async function reload() {
    try {
      const res = await fetch('/api/admin/feature-requests');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { requests: AdminFeatureRequestRow[] };
      setRows(data.requests);
      setReloadError(false);
    } catch {
      setReloadError(true);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      await checked(
        await fetch('/api/admin/feature-requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title.trim(), body: body.trim() || null }),
        }),
      );
    } catch (err) {
      setCreateError(`Not added: ${(err as Error).message}`);
      setCreating(false);
      return;
    }
    setTitle('');
    setBody('');
    // Outside the try: the request IS created by now; saying it failed would
    // have the admin add it twice.
    await reload();
    setCreating(false);
  }

  const counts: Record<Filter, number> = { all: rows.length, open: 0, in_progress: 0, not_doing: 0 };
  for (const r of rows) counts[r.status] += 1;
  const shown = filter === 'all' ? rows : rows.filter((r) => r.status === filter);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <form
        onSubmit={handleCreate}
        style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }}
        aria-label="New request"
      >
        <div style={kicker}>NEW REQUEST</div>
        <label style={fieldLabel}>
          Title
          <input
            style={input}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={FEATURE_REQUEST_TITLE_MAX}
            required
          />
        </label>
        <label style={fieldLabel}>
          Description (optional)
          <textarea
            style={{ ...input, fontSize: 13, resize: 'vertical' }}
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={FEATURE_REQUEST_BODY_MAX}
          />
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12 }}>
          {createError ? <p style={errorText} role="alert">{createError}</p> : null}
          <button type="submit" style={{ ...primaryBtn, opacity: creating || !title.trim() ? 0.6 : 1 }} disabled={creating || !title.trim()}>
            {creating ? 'Adding…' : 'Add request'}
          </button>
        </div>
      </form>

      {reloadError ? (
        <p style={errorText} role="alert">
          Saved, but the list did not reload. Refresh the page to see it.
        </p>
      ) : null}

      <div role="tablist" aria-label="Filter by status" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(['all', ...STATUSES] as Filter[]).map((f) => {
          const on = filter === f;
          return (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setFilter(f)}
              style={{
                padding: '7px 12px',
                borderRadius: 999,
                border: `1px solid ${on ? 'var(--tp-primary)' : 'var(--tp-border)'}`,
                background: on ? 'var(--tp-primary-muted)' : 'transparent',
                color: on ? 'var(--tp-text)' : 'var(--tp-muted)',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {f === 'all' ? 'All' : STATUS_LABEL[f]}{' '}
              <span style={{ opacity: 0.7, fontVariantNumeric: 'tabular-nums' }}>{counts[f]}</span>
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {shown.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--tp-muted)', margin: 0 }}>
            {rows.length === 0 ? 'No feature requests yet.' : 'None with this status.'}
          </p>
        ) : null}
        {shown.map((r) => (
          <RequestRow key={r.id} row={r} onChanged={reload} />
        ))}
      </div>
    </div>
  );
}

function RequestRow({ row, onChanged }: { row: AdminFeatureRequestRow; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.reply ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const closed = row.status === 'not_doing';
  const showEditor = editing || !row.reply;

  async function run(what: string, action: () => Promise<void>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(`${what} failed: ${(err as Error).message}`);
      setBusy(false);
      return;
    }
    after?.();
    await onChanged();
    setBusy(false);
  }

  const setStatus = (status: FeatureRequestStatus) =>
    run('Status change', () => patchRequest(row.id, { status }));
  const saveReply = () =>
    run('Saving the reply', () => patchRequest(row.id, { reply: draft.trim() || null }), () => setEditing(false));
  const removeReply = () =>
    run('Removing the reply', () => patchRequest(row.id, { reply: null }), () => {
      setEditing(false);
      setDraft('');
    });
  const remove = () => run('Delete', () => deleteRequest(row.id));

  return (
    <article
      data-testid={`admin-feature-request-${row.id}`}
      style={{
        ...card,
        background: closed ? 'var(--tp-surface-muted)' : 'var(--tp-surface)',
        display: 'flex',
        gap: 16,
        flexWrap: 'wrap',
        opacity: busy ? 0.7 : 1,
      }}
    >
      <div style={{ flex: 'none', width: 64, textAlign: 'center' }}>
        <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
          {row.voteCount}
        </div>
        <div style={{ ...kicker, letterSpacing: '0.12em', marginTop: 4 }}>
          {row.voteCount === 1 ? 'VOTE' : 'VOTES'}
        </div>
      </div>

      <div style={{ flex: '999 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{row.title}</h2>
          {row.body ? (
            <p style={{ margin: '4px 0 0', fontSize: 13, lineHeight: 1.45, color: 'var(--tp-muted)' }}>{row.body}</p>
          ) : null}
          <div style={{ fontSize: 11, color: 'var(--tp-subtle)', marginTop: 4 }}>Added {fmtDate(row.createdAt)}</div>
        </div>

        <div
          role="radiogroup"
          aria-label="Status"
          style={{ display: 'flex', alignSelf: 'flex-start', border: '1px solid var(--tp-border)', borderRadius: 8, overflow: 'hidden' }}
        >
          {STATUSES.map((s, i) => {
            const on = row.status === s;
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={busy}
                onClick={() => (on ? undefined : void setStatus(s))}
                style={{
                  padding: '7px 14px',
                  border: 0,
                  borderLeft: i === 0 ? 0 : '1px solid var(--tp-border)',
                  background: on ? (s === 'not_doing' ? 'var(--tp-border)' : 'var(--tp-primary)') : 'transparent',
                  color: on ? 'var(--tp-text)' : 'var(--tp-muted)',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: on ? 'default' : 'pointer',
                }}
              >
                {STATUS_LABEL[s]}
              </button>
            );
          })}
        </div>

        {showEditor ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={fieldLabel}>
              {closed ? 'Reason (shown in the app)' : 'Reply (shown in the app)'}
              <textarea
                style={{ ...input, fontSize: 13, resize: 'vertical' }}
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={FEATURE_REQUEST_REPLY_MAX}
              />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {editing ? (
                <button
                  type="button"
                  style={quietBtn}
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setDraft(row.reply ?? '');
                  }}
                >
                  Cancel
                </button>
              ) : null}
              {row.reply ? (
                <button type="button" style={quietBtn} disabled={busy} onClick={() => void removeReply()}>
                  {closed ? 'Remove reason' : 'Remove reply'}
                </button>
              ) : null}
              <button
                type="button"
                style={{ ...primaryBtn, padding: '7px 14px', fontSize: 12, opacity: busy || !draft.trim() ? 0.6 : 1 }}
                disabled={busy || !draft.trim()}
                onClick={() => void saveReply()}
              >
                {closed ? 'Save reason' : 'Save reply'}
              </button>
            </div>
          </div>
        ) : (
          <div
            style={{
              background: 'var(--tp-surface-muted)',
              border: '1px solid var(--tp-neutral-900)',
              borderRadius: 8,
              padding: '10px 12px',
              display: 'flex',
              gap: 12,
              alignItems: 'flex-start',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '0.8px', color: 'var(--tp-accent-400)' }}>
                REPLY · SHOWN IN THE APP
              </div>
              <p style={{ margin: '3px 0 0', fontSize: 13, lineHeight: 1.45 }}>{row.reply}</p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(row.reply ?? '');
                setEditing(true);
              }}
              style={{ background: 'transparent', border: 0, color: 'var(--tp-primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 4 }}
            >
              Edit
            </button>
          </div>
        )}

        {error ? <p style={errorText} role="alert">{error}</p> : null}
      </div>

      <div style={{ flex: 'none', marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
        {confirmDelete ? (
          <div
            style={{
              width: 220,
              background: 'var(--tp-danger-muted)',
              border: '1px solid var(--tp-danger-border)',
              borderRadius: 8,
              padding: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <p style={{ margin: 0, fontSize: 12, lineHeight: 1.4 }}>
              Deletes this request, its reply and its {row.voteCount} {row.voteCount === 1 ? 'vote' : 'votes'}. Users stop seeing it.
            </p>
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button type="button" style={{ ...quietBtn, color: 'var(--tp-text)' }} disabled={busy} onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove()}
                style={{ padding: '6px 10px', borderRadius: 8, border: 0, background: 'var(--tp-danger)', color: 'var(--tp-bg)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
              >
                Delete
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
            style={{ ...quietBtn, borderColor: 'var(--tp-danger-border)', color: 'var(--tp-danger)' }}
          >
            Delete
          </button>
        )}
      </div>
    </article>
  );
}
