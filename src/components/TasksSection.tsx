'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Task, TaskPriority, TaskStatus } from '@/types/trip';
import { tripApi } from '@/lib/api';

interface TasksSectionProps {
  tripId: number;
  legId: number;
  initialTasks: Task[];
  onChanged?: () => void;
  readonly?: boolean;
}

const PRIORITY_COLOR: Record<TaskPriority, string> = {
  high: '#E8927C',
  normal: '#7CB5E8',
  low: 'rgba(255,255,255,0.35)',
};

const STATUS_BADGE: Record<TaskStatus, { label: string; bg: string; fg: string }> = {
  open: { label: 'OPEN', bg: 'rgba(232,213,124,0.15)', fg: '#E8D57C' },
  answered: { label: 'ANSWERED', bg: 'rgba(124,232,163,0.15)', fg: '#7CE8A3' },
  dismissed: { label: 'DISMISSED', bg: 'rgba(255,255,255,0.06)', fg: 'rgba(255,255,255,0.4)' },
};

export default function TasksSection({ tripId, legId, initialTasks, onChanged, readonly = false }: TasksSectionProps) {
  const api = useMemo(() => tripApi(tripId), [tripId]);
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newRefUrl, setNewRefUrl] = useState('');
  const [newPriority, setNewPriority] = useState<TaskPriority>('normal');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editAnswer, setEditAnswer] = useState('');

  useEffect(() => {
    setTasks(initialTasks);
  }, [initialTasks]);

  async function reload() {
    try {
      const data = await api.listTasksForLeg(legId);
      if (Array.isArray(data)) setTasks(data as Task[]);
      onChanged?.();
    } catch {
      /* ignore */
    }
  }

  async function handleAdd() {
    const title = newTitle.trim();
    if (!title) return;
    try {
      await api.addTask({
        leg_id: legId,
        title,
        priority: newPriority,
        reference_url: newRefUrl.trim() || null,
      });
      setNewTitle('');
      setNewRefUrl('');
      setNewPriority('normal');
      setAdding(false);
      reload();
    } catch {
      /* ignore */
    }
  }

  async function patchTask(id: number, data: Partial<Task>) {
    try {
      await api.updateTask(id, data as Record<string, unknown>);
      reload();
    } catch {
      /* ignore */
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this task?')) return;
    try {
      await api.deleteTask(id);
      reload();
    } catch {
      /* ignore */
    }
  }

  function startResolve(task: Task) {
    setEditingId(task.id);
    setEditAnswer(task.answer || '');
  }

  async function saveResolve(id: number) {
    await patchTask(id, { status: 'answered', answer: editAnswer.trim() || null });
    setEditingId(null);
    setEditAnswer('');
  }

  return (
    <div
      style={{
        marginTop: 12,
        padding: '10px 14px',
        background: 'rgba(255,255,255,0.03)',
        borderRadius: 6,
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 6,
        }}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            color: 'rgba(255,255,255,0.35)',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          TASKS
        </div>
        {!readonly && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setAdding((v) => !v);
            }}
            style={{
              fontSize: 11,
              background: 'rgba(232,213,124,0.15)',
              border: '1px solid rgba(232,213,124,0.3)',
              color: '#E8D57C',
              padding: '3px 10px',
              borderRadius: 4,
              cursor: 'pointer',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            + Add Task
          </button>
        )}
      </div>

      {!readonly && adding && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            marginBottom: 8,
            padding: 8,
            background: 'rgba(0,0,0,0.25)',
            borderRadius: 4,
          }}
        >
          <input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Check Timmelsjoch pass opening..."
            style={{
              padding: '6px 10px',
              background: 'rgba(0,0,0,0.4)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 4,
              color: '#fff',
              fontSize: 12,
              outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={newRefUrl}
              onChange={(e) => setNewRefUrl(e.target.value)}
              placeholder="Reference URL (optional)"
              style={{
                flex: 1,
                padding: '6px 10px',
                background: 'rgba(0,0,0,0.4)',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 4,
                color: '#fff',
                fontSize: 12,
                outline: 'none',
              }}
            />
            <select
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value as TaskPriority)}
              style={{
                padding: '6px 8px',
                background: 'rgba(0,0,0,0.4)',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 4,
                color: '#fff',
                fontSize: 12,
                outline: 'none',
              }}
            >
              <option value="low">low</option>
              <option value="normal">normal</option>
              <option value="high">high</option>
            </select>
            <button
              onClick={handleAdd}
              style={{
                fontSize: 11,
                background: '#7CB5E8',
                border: 'none',
                color: '#000',
                padding: '6px 12px',
                borderRadius: 4,
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Add
            </button>
          </div>
        </div>
      )}

      {tasks.length === 0 && !adding && (
        <div
          style={{
            fontSize: 11,
            color: 'rgba(255,255,255,0.35)',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          No tasks. Penny will add things here when she sees something to verify.
        </div>
      )}

      {tasks.map((task) => {
        const badge = STATUS_BADGE[task.status];
        const isEditing = editingId === task.id;
        return (
          <div
            key={task.id}
            style={{
              padding: '8px 10px',
              background: task.status === 'open' ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.08)',
              borderRadius: 5,
              border: '1px solid rgba(255,255,255,0.05)',
              marginTop: 6,
              opacity: task.status === 'dismissed' ? 0.55 : 1,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: PRIORITY_COLOR[task.priority],
                  flexShrink: 0,
                  marginTop: 5,
                }}
                title={`${task.priority} priority`}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontSize: 13,
                      color: 'rgba(255,255,255,0.85)',
                      fontWeight: 500,
                      textDecoration: task.status === 'dismissed' ? 'line-through' : 'none',
                    }}
                  >
                    {task.title}
                  </span>
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      background: badge.bg,
                      color: badge.fg,
                      padding: '2px 6px',
                      borderRadius: 3,
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    {badge.label}
                  </span>
                  {task.created_by === 'penny' && (
                    <span
                      style={{
                        fontSize: 9,
                        color: 'rgba(255,255,255,0.4)',
                        fontFamily: "'JetBrains Mono', monospace",
                      }}
                    >
                      via Penny
                    </span>
                  )}
                </div>

                {task.description && (
                  <div
                    style={{
                      fontSize: 12,
                      color: 'rgba(255,255,255,0.5)',
                      marginTop: 3,
                      lineHeight: 1.4,
                    }}
                  >
                    {task.description}
                  </div>
                )}

                {(task.reference_url || task.reference_phone) && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                    {task.reference_url && (
                      <a
                        href={task.reference_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          fontSize: 11,
                          color: '#7CB5E8',
                          textDecoration: 'none',
                          padding: '3px 8px',
                          border: '1px solid rgba(124,181,232,0.3)',
                          borderRadius: 12,
                          background: 'rgba(124,181,232,0.08)',
                        }}
                      >
                        ↗ {task.reference_label || 'Reference'}
                      </a>
                    )}
                    {task.reference_phone && (
                      <a
                        href={`tel:${task.reference_phone.replace(/\s+/g, '')}`}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          fontSize: 11,
                          color: '#7CE8A3',
                          textDecoration: 'none',
                          padding: '3px 8px',
                          border: '1px solid rgba(124,232,163,0.3)',
                          borderRadius: 12,
                          background: 'rgba(124,232,163,0.08)',
                        }}
                      >
                        ☎ {task.reference_phone}
                      </a>
                    )}
                  </div>
                )}

                {task.answer && !isEditing && (
                  <div
                    style={{
                      marginTop: 8,
                      padding: '6px 8px',
                      background: 'rgba(124,232,163,0.08)',
                      border: '1px solid rgba(124,232,163,0.2)',
                      borderRadius: 4,
                      fontSize: 12,
                      color: 'rgba(255,255,255,0.85)',
                      lineHeight: 1.4,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 9,
                        fontWeight: 700,
                        letterSpacing: '0.08em',
                        color: '#7CE8A3',
                        marginBottom: 4,
                        fontFamily: "'JetBrains Mono', monospace",
                      }}
                    >
                      ANSWER
                    </div>
                    {task.answer}
                    {task.answer_source_url && (
                      <div style={{ marginTop: 4 }}>
                        <a
                          href={task.answer_source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: '#7CB5E8', fontSize: 11, textDecoration: 'none' }}
                        >
                          source ↗
                        </a>
                      </div>
                    )}
                  </div>
                )}

                {isEditing && (
                  <div style={{ marginTop: 8 }}>
                    <textarea
                      value={editAnswer}
                      onChange={(e) => setEditAnswer(e.target.value)}
                      placeholder="What did you find out?"
                      rows={2}
                      style={{
                        width: '100%',
                        padding: '6px 10px',
                        background: 'rgba(0,0,0,0.4)',
                        border: '1px solid rgba(255,255,255,0.15)',
                        borderRadius: 4,
                        color: '#fff',
                        fontSize: 12,
                        outline: 'none',
                        fontFamily: 'inherit',
                        resize: 'vertical',
                      }}
                    />
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <button
                        onClick={() => saveResolve(task.id)}
                        style={{
                          fontSize: 11,
                          background: '#7CE8A3',
                          border: 'none',
                          color: '#000',
                          padding: '5px 12px',
                          borderRadius: 4,
                          cursor: 'pointer',
                          fontWeight: 600,
                        }}
                      >
                        Save answer
                      </button>
                      <button
                        onClick={() => {
                          setEditingId(null);
                          setEditAnswer('');
                        }}
                        style={{
                          fontSize: 11,
                          background: 'transparent',
                          border: '1px solid rgba(255,255,255,0.15)',
                          color: 'rgba(255,255,255,0.5)',
                          padding: '5px 12px',
                          borderRadius: 4,
                          cursor: 'pointer',
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                {!readonly && task.status === 'open' && !isEditing && (
                  <>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        startResolve(task);
                      }}
                      style={{
                        fontSize: 11,
                        background: 'rgba(124,232,163,0.15)',
                        border: '1px solid rgba(124,232,163,0.3)',
                        color: '#7CE8A3',
                        padding: '3px 8px',
                        borderRadius: 4,
                        cursor: 'pointer',
                        fontFamily: "'JetBrains Mono', monospace",
                      }}
                    >
                      Resolve
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        patchTask(task.id, { status: 'dismissed' });
                      }}
                      style={{
                        fontSize: 11,
                        background: 'transparent',
                        border: '1px solid rgba(255,255,255,0.1)',
                        color: 'rgba(255,255,255,0.4)',
                        padding: '3px 8px',
                        borderRadius: 4,
                        cursor: 'pointer',
                        fontFamily: "'JetBrains Mono', monospace",
                      }}
                      title="Dismiss"
                    >
                      Skip
                    </button>
                  </>
                )}
                {!readonly && task.status !== 'open' && !isEditing && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      patchTask(task.id, { status: 'open' });
                    }}
                    style={{
                      fontSize: 11,
                      background: 'transparent',
                      border: '1px solid rgba(255,255,255,0.1)',
                      color: 'rgba(255,255,255,0.4)',
                      padding: '3px 8px',
                      borderRadius: 4,
                      cursor: 'pointer',
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    Reopen
                  </button>
                )}
                {!readonly && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(task.id);
                    }}
                    style={{
                      fontSize: 12,
                      background: 'transparent',
                      border: 'none',
                      color: 'rgba(255,255,255,0.35)',
                      cursor: 'pointer',
                      padding: '2px 6px',
                    }}
                    title="Delete task"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
