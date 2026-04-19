'use client';

import { useState, useRef, useEffect } from 'react';
import type { ChatMessage } from '@/types/trip';
import { tripApi } from '@/lib/api';

interface ChatPanelProps {
  tripId: number;
  initialMessages: ChatMessage[];
  onTripUpdated: () => void;
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
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export default function ChatPanel({ tripId, initialMessages, onTripUpdated, readonly = false }: ChatPanelProps) {
  const [messages, setMessages] = useState<UIMessage[]>(initialMessages);
  const [input, setInput] = useState('');
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Auto-grow textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
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

  const sendMessage = async () => {
    const trimmed = input.trim();
    if ((!trimmed && images.length === 0) || loading) return;

    const attachedImages = images;
    setInput('');
    setImages([]);

    const tempUserMsg: UIMessage = {
      id: Date.now(),
      trip_id: tripId,
      role: 'user',
      content: trimmed,
      changes_made: null,
      created_at: new Date().toISOString(),
      imageDataUrls: attachedImages.map((i) => i.dataUrl),
    };
    setMessages((prev) => [...prev, tempUserMsg]);
    setLoading(true);

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
            changes_made: null,
            created_at: new Date().toISOString(),
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now() + 1,
            trip_id: tripId,
            role: 'assistant',
            content: data.response,
            changes_made: data.changes ? JSON.stringify(data.changes) : null,
            created_at: new Date().toISOString(),
          },
        ]);
        if (data.changes) onTripUpdated();
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          trip_id: tripId,
          role: 'assistant',
          content: 'Failed to reach the server. Check that your ANTHROPIC_API_KEY is set.',
          changes_made: null,
          created_at: new Date().toISOString(),
        },
      ]);
    } finally {
      setLoading(false);
    }
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
        height: '100%',
        background: '#0D0D0D',
        position: 'relative',
      }}
    >
      {dragOver && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(124,181,232,0.12)',
            border: '2px dashed rgba(124,181,232,0.6)',
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#7CB5E8',
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
          borderBottom: '1px solid rgba(255,255,255,0.08)',
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
            background: 'linear-gradient(135deg, #7CB5E8 0%, #7CE8A3 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#000',
            fontWeight: 800,
            fontSize: 13,
            flexShrink: 0,
          }}
        >
          P
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', lineHeight: 1.1 }}>
            Penny
          </div>
          <div
            style={{
              fontSize: 10,
              color: 'rgba(255,255,255,0.4)',
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: '0.04em',
              marginTop: 2,
            }}
          >
            Trip planner AI
          </div>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {messages.length === 0 && (
          <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 13, textAlign: 'center', marginTop: 40 }}>
            Ask Penny to modify your trip plan. For example:
            <br />
            <em>&quot;Move the Nürburgring day to after Denmark&quot;</em>
            <br />
            <em>&quot;Find overnight spots near Trondheim&quot;</em>
            <br />
            <em>&quot;Add a rest day in Hamburg&quot;</em>
            <br />
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)' }}>
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
              background: msg.role === 'user' ? 'rgba(124,181,232,0.15)' : 'rgba(255,255,255,0.05)',
              border: `1px solid ${msg.role === 'user' ? 'rgba(124,181,232,0.2)' : 'rgba(255,255,255,0.08)'}`,
              fontSize: 14,
              color: 'rgba(255,255,255,0.85)',
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
                      border: '1px solid rgba(255,255,255,0.1)',
                      objectFit: 'cover',
                    }}
                  />
                ))}
              </div>
            )}
            {msg.content}
            {msg.changes_made && (
              <div
                style={{
                  marginTop: 8,
                  padding: '6px 8px',
                  background: 'rgba(124,232,163,0.1)',
                  borderRadius: 4,
                  border: '1px solid rgba(124,232,163,0.2)',
                  fontSize: 11,
                  color: '#7CE8A3',
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                Changes applied to trip
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
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.08)',
              fontSize: 14,
              color: 'rgba(255,255,255,0.4)',
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
                border: '1px solid rgba(255,255,255,0.15)',
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
                  background: 'rgba(0,0,0,0.7)',
                  color: '#fff',
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
            borderTop: '1px solid rgba(255,255,255,0.08)',
            color: 'rgba(255,255,255,0.5)',
            fontSize: 12,
            textAlign: 'center',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          Demo trip — clone it from the trips list to chat with Penny.
        </div>
      ) : (
      <div
        style={{
          padding: '12px 16px',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          gap: 8,
          alignItems: 'flex-end',
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
        <button
          onClick={() => fileInputRef.current?.click()}
          title="Attach image"
          style={{
            padding: '10px 12px',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8,
            color: 'rgba(255,255,255,0.6)',
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          📎
        </button>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Ask Penny to change the plan...  (Enter to send, Shift+Enter for newline)"
          disabled={loading}
          rows={1}
          style={{
            flex: 1,
            padding: '10px 14px',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8,
            color: '#fff',
            fontSize: 14,
            outline: 'none',
            fontFamily: 'inherit',
            resize: 'none',
            lineHeight: 1.4,
            maxHeight: 200,
            overflowY: 'auto',
          }}
        />
        <button
          onClick={sendMessage}
          disabled={loading || (!input.trim() && images.length === 0)}
          style={{
            padding: '10px 20px',
            background: input.trim() || images.length > 0 ? '#7CB5E8' : 'rgba(255,255,255,0.06)',
            border: 'none',
            borderRadius: 8,
            color: input.trim() || images.length > 0 ? '#000' : 'rgba(255,255,255,0.3)',
            fontSize: 14,
            fontWeight: 600,
            cursor: input.trim() || images.length > 0 ? 'pointer' : 'default',
            transition: 'background 0.2s',
          }}
        >
          Send
        </button>
      </div>
      )}
    </div>
  );
}
