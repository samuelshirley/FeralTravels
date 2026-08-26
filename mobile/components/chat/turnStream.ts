import EventSource from "react-native-sse";
import { API_BASE_URL } from "@/lib/config";
import type { AppliedEvent } from "./types";

/* ═══════════════════════════════════════════════════════════════════════════
 * READ THIS BEFORE "SIMPLIFYING" THIS FILE BACK INTO A `fetch`.
 *
 * The web client streams Penny's turn with
 *   const res = await fetch('/api/trip/replan', ...);
 *   const reader = res.body.getReader();          // ← the important bit
 * That CANNOT be ported. React Native's fetch is implemented on XMLHttpRequest
 * and **`Response.body` is not a ReadableStream** — it is undefined. Awaiting
 * `res.text()` works, but only resolves once the whole turn is finished, which
 * throws away the entire point of streaming (a full replan takes 30-120s and
 * the user would stare at a spinner for all of it).
 *
 * Plain `EventSource` is also out: the DOM one is GET-only with no custom
 * headers, and we need POST + a JSON body + `Authorization: Bearer <token>`
 * (mobile has no cookie). `react-native-sse` is an XHR-based EventSource that
 * supports both, reading `xhr.responseText` incrementally as it grows.
 *
 * So: this module is the ONLY place that talks to /api/trip/replan, and it must
 * stay on react-native-sse. If you find yourself writing `for await (const
 * chunk of res.body)`, you are about to ship a chat panel that never shows a
 * word until the turn ends.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * How long we wait for the FIRST frame before concluding there is no live
 * stream at all. The server answers with plain JSON (`{turn}`) instead of
 * `text/event-stream` when this turn was queued behind another in-flight turn,
 * or when this exact idempotency key was already accepted (replay). We can't
 * read the response's content-type through EventSource, and a JSON body
 * contains no `\n\n` frame separator, so silence IS the signal: the caller
 * falls back to polling the durable turn record, which is exactly what the web
 * does on its non-SSE branch.
 */
const FIRST_FRAME_TIMEOUT_MS = 15_000;

/**
 * Silence *after* frames have started. The server emits `iteration_start` and
 * text chunks continuously, so a two-minute gap means the socket is dead (the
 * phone slept, the radio dropped, the process was frozen). We stop waiting and
 * hand over to the crash-heal path rather than hanging a bubble forever.
 */
const IDLE_TIMEOUT_MS = 120_000;

export type TurnStreamResult =
  /** Terminal `applied` frame — the authoritative result. */
  | { outcome: "applied"; event: AppliedEvent }
  /** Server-sent `error` frame: the turn failed server-side, message is user-facing. */
  | { outcome: "stream-error"; message: string }
  /**
   * Non-2xx before any streaming (rate limit, validation, missing key).
   *
   * `body` is the PARSED error JSON, not just its `error` string, because not
   * every non-2xx is an error to show. A 402 carries a machine-readable `code`
   * alongside the prose, and the caller has to branch on that code to turn the
   * bubble into Penny's paywall instead of a red "Something went wrong". Giving
   * the caller only `message` would force it to string-match copy that is
   * explicitly meant to change. Null when the body was absent or not JSON.
   */
  | {
      outcome: "http-error";
      message: string;
      status: number;
      body: Record<string, unknown> | null;
    }
  /** 200 but no SSE frames — queued turn / idempotent replay; poll the record. */
  | { outcome: "silent" }
  /** Connection died mid-turn. The server keeps going; heal from the record. */
  | { outcome: "dropped"; detail?: string };

export interface TurnStreamHandlers {
  /** Server persisted the user message — "Delivered". */
  onReceived: () => void;
  /** Penny is building context / about to call Claude — "Read". */
  onReading: () => void;
  /** A paragraph of Penny's reply. */
  onText: (chunk: string) => void;
}

export interface TurnStreamHandle {
  /** Resolves exactly once, with whichever terminal condition happened first. */
  result: Promise<TurnStreamResult>;
  /** Tear the socket down (unmount). Settles `result` as `dropped`. */
  cancel: () => void;
}

/**
 * POST a replan and stream the turn. `headers` must already carry the resolved
 * `Authorization` header (`await authHeaders()`) — EventSource is constructed
 * synchronously so it can't await one itself.
 */
export function startTurnStream(args: {
  body: unknown;
  headers: Record<string, string>;
  handlers: TurnStreamHandlers;
}): TurnStreamHandle {
  const { body, headers, handlers } = args;

  let settle: (r: TurnStreamResult) => void = () => {};
  const result = new Promise<TurnStreamResult>((resolve) => {
    settle = resolve;
  });

  let done = false;
  let sawFrame = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const es = new EventSource(`${API_BASE_URL}/api/trip/replan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    // A replan is NOT idempotent-free to re-issue on a whim: react-native-sse's
    // default behaviour is to reconnect (re-POST!) 5s after the response ends.
    // Zero disables that entirely — one send, one turn.
    pollingInterval: 0,
    // The library's `timeout` aborts the request wholesale at N ms regardless
    // of activity, which would guillotine a long-but-healthy plan. We police
    // liveness with our own idle timer instead.
    timeout: 0,
    // The library idles 500ms before its first connect by default; a send
    // should hit the wire immediately.
    timeoutBeforeConnection: 0,
    // Our frames are `data: {...}\n\n`. Pinning the line ending skips the
    // library's autodetect, which console.warns on a body that has no newline
    // at all — i.e. every queued-turn JSON response.
    lineEndingCharacter: "\n",
  });

  const finish = (r: TurnStreamResult) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    es.removeAllEventListeners();
    es.close();
    settle(r);
  };

  const armWatchdog = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => finish(sawFrame ? { outcome: "dropped", detail: "idle" } : { outcome: "silent" }),
      sawFrame ? IDLE_TIMEOUT_MS : FIRST_FRAME_TIMEOUT_MS
    );
  };
  armWatchdog();

  es.addEventListener("message", (event) => {
    sawFrame = true;
    armWatchdog();
    if (!event.data) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (ev.kind) {
      case "received":
        handlers.onReceived();
        break;
      case "reading":
        handlers.onReading();
        break;
      case "iteration_start":
        // No UI change — the next text/tool event drives the bubble.
        break;
      case "text": {
        const chunk = typeof ev.chunk === "string" ? ev.chunk : "";
        if (chunk) handlers.onText(chunk);
        break;
      }
      case "applied":
        finish({ outcome: "applied", event: ev as unknown as AppliedEvent });
        break;
      case "error": {
        const raw = typeof ev.message === "string" ? ev.message : "";
        // Strip noisy stack traces / internal paths — keep the first sentence.
        const cleaned = raw.split("\n")[0]?.slice(0, 200) || "";
        finish({
          outcome: "stream-error",
          message: cleaned
            ? `Error: ${cleaned}`
            : "Something went wrong while updating your trip.",
        });
        break;
      }
    }
  });

  es.addEventListener("error", (event) => {
    if (event.type === "timeout") {
      finish({ outcome: "dropped", detail: "timeout" });
      return;
    }
    if (event.type === "exception") {
      finish({ outcome: "dropped", detail: event.message });
      return;
    }
    // xhrStatus 0 = the request never reached a server (offline, DNS, refused).
    if (event.xhrStatus >= 400) {
      // Pre-stream errors come back as plain JSON, same as the web's !res.ok
      // branch — the whole body is in `message` because XHR failed the request.
      let message = `Request failed (${event.xhrStatus})`;
      let body: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(event.message ?? "") as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
          const err = (parsed as { error?: unknown }).error;
          if (typeof err === "string") message = err;
        }
      } catch {
        // Non-JSON error body — keep the status-code message, and leave `body`
        // null so the caller can tell "no structured reason" apart from "a
        // structured reason that happened to have no code".
      }
      finish({ outcome: "http-error", message, status: event.xhrStatus, body });
      return;
    }
    finish({ outcome: "dropped", detail: event.message });
  });

  return {
    result,
    cancel: () => finish({ outcome: "dropped", detail: "cancelled" }),
  };
}
