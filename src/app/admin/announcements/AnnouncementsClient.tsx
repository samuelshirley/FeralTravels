'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  buttonText: string;
  active: boolean;
  createdAt: string;
  dismissCount: number;
}

const card: React.CSSProperties = {
  background: 'var(--tp-surface)',
  border: '1px solid var(--tp-border)',
  borderRadius: 10,
  padding: 16,
  boxShadow: 'var(--tp-shadow-sm)',
};

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--tp-muted)',
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 14,
  border: '1px solid var(--tp-border)',
  borderRadius: 'var(--tp-radius-sm, 8px)',
  fontFamily: 'inherit',
  color: 'var(--tp-text)',
  background: 'var(--tp-surface)',
  boxSizing: 'border-box' as const,
};

export default function AnnouncementsClient({
  initialRows,
}: {
  initialRows: AnnouncementRow[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [buttonText, setButtonText] = useState('Got it');
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !body.trim() || saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/admin/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          buttonText: buttonText.trim() || 'Got it',
        }),
      });
      if (!res.ok) throw new Error('Failed');
      setTitle('');
      setBody('');
      setButtonText('Got it');
      router.refresh();
      // Refetch rows
      const listRes = await fetch('/api/admin/announcements');
      if (listRes.ok) setRows(await listRes.json());
    } catch {
      alert('Failed to create announcement');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(id: string, active: boolean) {
    setToggling(id);
    try {
      await fetch('/api/admin/announcements', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, active }),
      });
      const listRes = await fetch('/api/admin/announcements');
      if (listRes.ok) setRows(await listRes.json());
    } catch {
      alert('Failed to toggle');
    } finally {
      setToggling(null);
    }
  }

  return (
    <>
      {/* Create form */}
      <section style={{ ...card, marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 16px' }}>
          Ship a new announcement
        </h2>
        <form onSubmit={handleCreate}>
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Title</label>
            <input
              style={inputStyle}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Lots of Yuge updates"
              required
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Body</label>
            <textarea
              style={{ ...inputStyle, resize: 'vertical', minHeight: 80 }}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What do you want to tell your users?"
              required
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Button text</label>
            <input
              style={inputStyle}
              value={buttonText}
              onChange={(e) => setButtonText(e.target.value)}
              placeholder="Got it"
            />
          </div>
          <button
            type="submit"
            disabled={saving || !title.trim() || !body.trim()}
            style={{
              padding: '10px 24px',
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'inherit',
              borderRadius: 'var(--tp-radius-sm, 8px)',
              border: 'none',
              background: saving ? 'var(--tp-muted)' : 'var(--tp-primary)',
              color: 'var(--tp-on-primary)',
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: !title.trim() || !body.trim() ? 0.5 : 1,
            }}
          >
            {saving ? 'Creating...' : 'Ship it'}
          </button>
        </form>
      </section>

      {/* Existing announcements */}
      <section style={card}>
        <h2 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 16px' }}>
          All announcements
        </h2>
        {rows.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--tp-subtle)', padding: '8px 0' }}>
            No announcements yet. Ship one above.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {rows.map((r) => (
              <div
                key={r.id}
                style={{
                  border: '1px solid var(--tp-border)',
                  borderRadius: 8,
                  padding: 14,
                  background: r.active
                    ? 'var(--tp-success-muted)'
                    : 'var(--tp-surface-muted)',
                  opacity: r.active ? 1 : 0.7,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 12,
                    marginBottom: 6,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {r.title}
                      <span
                        style={{
                          marginLeft: 8,
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: '0.1em',
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: r.active
                            ? 'var(--tp-success)'
                            : 'var(--tp-muted)',
                          color: '#fff',
                        }}
                      >
                        {r.active ? 'ACTIVE' : 'INACTIVE'}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--tp-muted)',
                        marginTop: 4,
                        lineHeight: 1.5,
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {r.body}
                    </div>
                  </div>
                  <button
                    onClick={() => handleToggle(r.id, !r.active)}
                    disabled={toggling === r.id}
                    style={{
                      flexShrink: 0,
                      padding: '6px 12px',
                      fontSize: 11,
                      fontWeight: 600,
                      fontFamily: 'inherit',
                      borderRadius: 6,
                      border: '1px solid var(--tp-border)',
                      background: 'var(--tp-surface)',
                      color: r.active ? 'var(--tp-danger)' : 'var(--tp-success)',
                      cursor: toggling === r.id ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {r.active ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: 16,
                    fontSize: 11,
                    color: 'var(--tp-subtle)',
                    marginTop: 8,
                  }}
                >
                  <span>
                    Button: &quot;{r.buttonText}&quot;
                  </span>
                  <span>
                    {r.dismissCount} dismissed
                  </span>
                  <span>
                    {new Date(r.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
