import { useEffect, useRef, useState } from "react";
import { apiFetch, type Me } from "@/lib/api";
import {
  createAiConsentController,
  type AiConsentController,
  type AiConsentSnapshot,
} from "@/shared/lib/aiConsent";

/**
 * The one-time "Penny uses Anthropic's Claude" agreement (App Review
 * 5.1.2(i)) for ChatPanel. The logic is the shared, unit-tested
 * `createAiConsentController` (shared/lib/aiConsent.ts); this only supplies
 * the two requests and re-renders on change. Mirrors
 * src/components/useAiConsent.ts.
 *
 * The server refuses every Penny route without the agreement
 * (`src/server/aiConsent.ts`), so this is how a user SAYS yes — never what
 * stops a request.
 */
export function useAiConsent(enabled: boolean): AiConsentSnapshot & Omit<AiConsentController, "get" | "load"> {
  const [snapshot, setSnapshot] = useState<AiConsentSnapshot>({
    status: "unknown",
    sheetOpen: false,
    saving: false,
    error: null,
  });
  const controller = useRef<AiConsentController | null>(null);
  if (!controller.current) {
    controller.current = createAiConsentController({
      fetchConsent: async () =>
        (await apiFetch<Me>("/api/me", { skipGlobalErrorReport: true })).ai_consent === true,
      saveConsent: async () => {
        await apiFetch("/api/me/preferences", {
          method: "PATCH",
          body: { ai_consent: true },
          skipGlobalErrorReport: true,
        });
      },
      onChange: setSnapshot,
    });
  }
  const c = controller.current;

  useEffect(() => {
    if (enabled) void c.load();
  }, [enabled, c]);

  return {
    ...snapshot,
    ensure: c.ensure,
    open: c.open,
    agree: c.agree,
    notNow: c.notNow,
    requiredByServer: c.requiredByServer,
  };
}
