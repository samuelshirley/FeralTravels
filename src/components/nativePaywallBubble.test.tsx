import { readFileSync } from 'node:fs';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { withPaywallNotice } from '@/lib/paywallNotice';

/**
 * The native paywall bubble: present whenever the account is blocked and the
 * chat is on screen, and present exactly once.
 *
 * WHY THIS TEST EXISTS: the bubble used to be pushed into ChatPanel's message
 * state by an effect on mount. That effect raced the one that loads chat
 * history, which lands with `setMessages(data.messages)` — a wholesale replace.
 * Whichever request answered last decided whether the user saw the message, so
 * it showed up on one visit to the chat and was silently gone on the next.
 * It is now DERIVED from entitlement state at render time, and this file is
 * what keeps it that way.
 *
 * WHY IT TESTS A HARNESS AND NOT `mobile/components/ChatPanel.tsx`: there is no
 * React Native test runner in this repo — `react-native` is not resolvable from
 * the root, so the real panel cannot be mounted here at all. What CAN be
 * executed is the derivation the panel now renders through, so the harness
 * below reproduces the panel's shape around the real shipped function: state
 * that history replaces wholesale, entitlement arriving separately, and the
 * mount/unmount/remount the user actually did.
 *
 * IT NO LONGER REACHES INTO `mobile/`. It used to, through a non-literal
 * specifier chosen to keep that file out of the root tsconfig's type graph.
 * That dodged the type graph and not the BUILD graph: vitest still transformed
 * the mobile file, `mobile/tsconfig.json` extends `expo/tsconfig.base`, and
 * CI's unit job never installs `mobile/node_modules` — so the suite failed
 * there with "Tsconfig not found" while passing on a machine that happens to
 * have both trees installed. The derivation now lives in the shared mirror and
 * is imported like any other module.
 */

interface Msg {
  id: string;
  trip_id: string;
  role: 'user' | 'assistant';
  content: string;
  kind: string;
  changes_made: string | null;
  created_at: string;
  paywall?: boolean;
}

interface Ent {
  entitled: boolean;
  paywall: { message: string; buttonLabel: string } | null;
}

// This project does not enable Vitest globals, so RTL's auto-cleanup never
// registers — without this every render stays in the document and the counts
// below become cumulative.
afterEach(() => {
  cleanup();
});

const BLOCKED: Ent = {
  entitled: false,
  paywall: { message: 'Your seven days are up.', buttonLabel: 'Keep planning' },
};
const ENTITLED: Ent = { entitled: true, paywall: null };

function penny(id: string, content: string, paywall = false): Msg {
  return {
    id,
    trip_id: 'trip-1',
    role: 'assistant',
    content,
    kind: 'ai',
    changes_made: null,
    created_at: '2026-08-27T09:00:00.000Z',
    paywall,
  };
}

/**
 * ChatPanel's shape, minus everything that needs a phone: a transcript the
 * history load replaces wholesale, an entitlement answer that arrives on its
 * own schedule, and a render that derives the bubble from the two.
 */
function Transcript({
  entitlement,
  history,
  historyArrivesLate,
}: {
  entitlement: Ent | null;
  history: Msg[];
  /** Reproduces the race: history answering after the entitlement call did. */
  historyArrivesLate?: boolean;
}) {
  const [messages, setMessages] = useState<Msg[]>(historyArrivesLate ? [] : history);

  useEffect(() => {
    if (!historyArrivesLate) return;
    // The real panel does exactly this — a wholesale replace, not a merge.
    setMessages(history);
  }, [history, historyArrivesLate]);

  return (
    <div>
      {withPaywallNotice(messages, entitlement, 'trip-1').map((m) => (
        <p key={m.id} data-testid={m.paywall ? 'paywall-bubble' : 'bubble'}>
          {m.content}
        </p>
      ))}
    </div>
  );
}

describe('native paywall bubble', () => {
  const history = [penny('m1', 'Where are we going?')];

  it('is there on mount, and still there after leaving the chat and coming back', () => {
    const view = render(<Transcript entitlement={BLOCKED} history={history} />);
    expect(screen.getAllByTestId('paywall-bubble')).toHaveLength(1);

    // Leaving the chat screen unmounts the panel.
    view.unmount();

    // Coming back mounts a fresh one, which reloads history from /api/chat —
    // where the bubble has never been persisted and never will be.
    render(<Transcript entitlement={BLOCKED} history={history} />);
    const bubbles = screen.getAllByTestId('paywall-bubble');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toHaveTextContent('Your seven days are up.');
  });

  it('survives a history load that lands after the entitlement answer', async () => {
    render(
      <Transcript entitlement={BLOCKED} history={history} historyArrivesLate />
    );
    // The replace has happened; the bubble is derived, so it cannot be lost.
    await act(async () => {});
    expect(screen.getAllByTestId('paywall-bubble')).toHaveLength(1);
    expect(screen.getAllByTestId('bubble')).toHaveLength(1);
  });

  it('never appears twice when a mid-turn 402 already rewrote a bubble', () => {
    render(
      <Transcript
        entitlement={BLOCKED}
        history={[penny('m1', 'Where next?'), penny('m2', 'Your seven days are up.', true)]}
      />
    );
    expect(screen.getAllByTestId('paywall-bubble')).toHaveLength(1);
  });

  it('is absent for an entitled account, and while the verdict is unknown', () => {
    const view = render(<Transcript entitlement={ENTITLED} history={history} />);
    expect(screen.queryAllByTestId('paywall-bubble')).toHaveLength(0);
    view.unmount();

    // Null is "could not ask" — a phone in a tunnel must not paywall anyone.
    render(<Transcript entitlement={null} history={history} />);
    expect(screen.queryAllByTestId('paywall-bubble')).toHaveLength(0);
  });
});

/**
 * The harness above proves the derivation is correct; this proves the panel
 * still goes through it. Without this pair, someone could reinstate the
 * append-on-mount effect and every assertion above would keep passing while the
 * bug came straight back.
 */
describe('mobile/components/ChatPanel.tsx', () => {
  const source = readFileSync('mobile/components/ChatPanel.tsx', 'utf8');

  it('renders the transcript through the derivation, not raw message state', () => {
    expect(source).toContain('withPaywallNotice');
    expect(source).toContain('visibleMessages.map(');
    // The raw list is still the source of truth for sending and queueing, but
    // it must not be what the bubbles are drawn from.
    expect(source).not.toContain('{messages.map(');
  });

  it('does not author the synthetic bubble into chat state', () => {
    // Building it here is the shape that raced the history load. The only
    // remaining write of `paywall: true` is the mid-turn 402 rewriting a real
    // pending bubble in place, which carries no id of its own.
    expect(source).not.toContain('PAYWALL_MESSAGE_ID');
  });
});
