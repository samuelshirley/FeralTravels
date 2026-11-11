'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import {
  AI_CONSENT_VERSION,
  consentVersionFromMe,
  createAiConsentController,
  type AiConsentController,
  type AiConsentSnapshot,
} from '@/lib/aiConsent';

/**
 * The web half of the "Penny uses Anthropic and TypeSafe" agreement (App Review
 * 5.1.2(i)) — the same shared controller the phone runs
 * (mobile/lib/useAiConsent.ts), with the web's `apiFetch`.
 */
export function useAiConsent(enabled: boolean): AiConsentSnapshot & Omit<AiConsentController, 'get' | 'load'> {
  const [snapshot, setSnapshot] = useState<AiConsentSnapshot>({
    status: 'unknown',
    sheetOpen: false,
    saving: false,
    error: null,
  });
  const controller = useRef<AiConsentController | null>(null);
  if (!controller.current) {
    controller.current = createAiConsentController({
      fetchConsent: async () =>
        consentVersionFromMe(
          await apiFetch<{ ai_consent?: boolean; ai_consent_version?: number | null }>('/api/me', {
            skipGlobalErrorReport: true,
          })
        ),
      saveConsent: async () => {
        await apiFetch('/api/me/preferences', {
          method: 'PATCH',
          body: { ai_consent: true, ai_consent_version: AI_CONSENT_VERSION },
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
