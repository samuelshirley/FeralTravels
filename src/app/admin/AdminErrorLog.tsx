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
  borderBottom: '1px solid rgba(255,255,255,0.12)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.1em',
  color: 'rgba(255,255,255,0.45)',
  fontFamily: "'JetBrains Mono', monospace",
  textAlign: 'left',
  textTransform: 'uppercase',
};

const tdStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid rgba(255,255,255,0.05)',
  fontSize: 12,
  color: 'rgba(255,255,255,0.85)',
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
          color: 'rgba(255,255,255,0.4)',
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
                  fontFamily: "'JetBrains Mono', monospace",
                  color: 'rgba(255,255,255,0.5)',
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
                      color: 'rgba(255,255,255,0.4)',
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    {r.userEmail}
                  </div>
                )}
              </td>
              <td
                style={{
                  ...tdStyle,
                  fontFamily: "'JetBrains Mono', monospace",
                  color: '#E8D57C',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.provider}
              </td>
              <td
                style={{
                  ...tdStyle,
                  color: '#E87C7C',
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
        background: 'rgba(0,0,0,0.6)',
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
          background: '#0F0F0F',
          border: '1px solid rgba(255,255,255,0.12)',
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
                color: 'rgba(255,255,255,0.45)',
                fontFamily: "'JetBrains Mono', monospace",
                textTransform: 'uppercase',
              }}
            >
              Error {row.id}
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: '4px 0 0' }}>
              {row.provider}
            </h2>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.15)',
              color: 'rgba(255,255,255,0.7)',
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
            <span style={{ color: 'rgba(255,255,255,0.5)', marginLeft: 6 }}>
              {'<'}
              {row.userEmail}
              {'>'}
            </span>
          )}
          {row.userId && (
            <div
              style={{
                fontSize: 10,
                color: 'rgba(255,255,255,0.35)',
                fontFamily: "'JetBrains Mono', monospace",
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
              style={{ color: '#7CB5E8', textDecoration: 'none' }}
            >
              #{row.tripId}
            </Link>
          ) : (
            <span style={{ color: 'rgba(255,255,255,0.4)' }}>(no trip context)</span>
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
          color: 'rgba(255,255,255,0.4)',
          fontFamily: "'JetBrains Mono', monospace",
          textTransform: 'uppercase',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 13,
          color: 'rgba(255,255,255,0.85)',
          fontFamily: monospace ? "'JetBrains Mono', monospace" : 'inherit',
          wordBreak: 'break-word',
          background: monospace ? 'rgba(232,124,124,0.06)' : 'transparent',
          border: monospace ? '1px solid rgba(232,124,124,0.2)' : 'none',
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
