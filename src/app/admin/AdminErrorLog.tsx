'use client';

import { useState } from 'react';
import Link from 'next/link';

export interface AdminErrorRow {
  id: number;
  createdAt: string; // ISO from server
  provider: string;
  errorMessage: string | null;
  tripId: number | null;
  userId: string | null;
  userEmail: string | null;
  userName: string | null;
}

interface Props {
  rows: AdminErrorRow[];
}

const thStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid var(--tp-border-strong)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.1em',
  color: 'var(--tp-muted)',
  
  textAlign: 'left',
  textTransform: 'uppercase',
};

const tdStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid var(--tp-border)',
  fontSize: 12,
  color: 'var(--tp-text)',
  verticalAlign: 'top',
};

function fmtRel(iso: string): string {
  const diff = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

export default function AdminErrorLog({ rows }: Props) {
  const [selected, setSelected] = useState<AdminErrorRow | null>(null);

  if (rows.length === 0) {
    return (
      <div
        style={{
          fontSize: 12,
          color: 'var(--tp-muted)',
          padding: '12px 4px',
        }}
      >
        No errors logged in this window. Nice and quiet.
      </div>
    );
  }

  return (
    <>
      <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={thStyle}>When</th>
            <th style={thStyle}>User</th>
            <th style={thStyle}>Provider</th>
            <th style={thStyle}>Message</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              onClick={() => setSelected(r)}
              style={{ cursor: 'pointer' }}
              title="Click for details"
            >
              <td
                style={{
                  ...tdStyle,
                  
                  color: 'var(--tp-muted)',
                  whiteSpace: 'nowrap',
                }}
              >
                {fmtRel(r.createdAt)}
              </td>
              <td style={tdStyle}>
                <div style={{ fontWeight: 600 }}>{r.userName || r.userEmail || '(anon)'}</div>
                {r.userEmail && r.userName && (
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--tp-muted)',
                      
                    }}
                  >
                    {r.userEmail}
                  </div>
                )}
              </td>
              <td
                style={{
                  ...tdStyle,
                  
                  color: 'var(--tp-gold)',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.provider}
              </td>
              <td
                style={{
                  ...tdStyle,
                  color: 'var(--tp-danger)',
                  maxWidth: 320,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.errorMessage || '(no message)'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {selected && <ErrorDetailModal row={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function ErrorDetailModal({
  row,
  onClose,
}: {
  row: AdminErrorRow;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--tp-overlay)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 640,
          maxHeight: '85vh',
          background: 'var(--tp-surface)',
          border: '1px solid var(--tp-border)',
          borderRadius: 10,
          overflow: 'auto',
          padding: '20px 22px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 8,
            marginBottom: 16,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.12em',
                color: 'var(--tp-subtle)',
                
                textTransform: 'uppercase',
              }}
            >
              Error {row.id}
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: '4px 0 0', color: 'var(--tp-text)' }}>
              {row.provider}
            </h2>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: '1px solid var(--tp-border)',
              color: 'var(--tp-muted)',
              borderRadius: 4,
              padding: '4px 10px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>

        <DetailRow label="When">
          {new Date(row.createdAt).toISOString()} ({fmtRel(row.createdAt)})
        </DetailRow>
        <DetailRow label="User">
          {row.userName || '—'}
          {row.userEmail && (
            <span style={{ color: 'var(--tp-muted)', marginLeft: 6 }}>
              {'<'}
              {row.userEmail}
              {'>'}
            </span>
          )}
          {row.userId && (
            <div
              style={{
                fontSize: 10,
                color: 'var(--tp-subtle)',
                
                marginTop: 2,
              }}
            >
              id: {row.userId}
            </div>
          )}
        </DetailRow>
        <DetailRow label="Trip">
          {row.tripId ? (
            <Link
              href={`/trips/${row.tripId}`}
              style={{ color: 'var(--tp-primary)', textDecoration: 'none' }}
            >
              #{row.tripId}
            </Link>
          ) : (
            <span style={{ color: 'var(--tp-muted)' }}>(no trip context)</span>
          )}
        </DetailRow>
        <DetailRow label="Error message" monospace>
          {row.errorMessage || '(no message recorded)'}
        </DetailRow>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  children,
  monospace,
}: {
  label: string;
  children: React.ReactNode;
  monospace?: boolean;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.1em',
          color: 'var(--tp-muted)',
          
          textTransform: 'uppercase',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 13,
          color: 'var(--tp-text)',
          fontFamily: 'inherit',
          wordBreak: 'break-word',
          background: 'var(--tp-danger-muted)',
          border: monospace ? '1px solid rgba(198, 93, 74, 0.3)' : 'none',
          padding: monospace ? '10px 12px' : 0,
          borderRadius: monospace ? 4 : 0,
          lineHeight: 1.5,
        }}
      >
        {children}
      </div>
    </div>
  );
}
