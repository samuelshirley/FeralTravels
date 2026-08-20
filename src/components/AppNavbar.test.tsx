import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import AppNavbar from '@/components/AppNavbar';

/**
 * The account button has exactly two states and no third one:
 *
 *  - a Google profile photo, when the session carries one;
 *  - a generic person glyph otherwise — emailed-code sign-ins, and every
 *    Apple sign-in, since the Apple ID token has no `picture` claim.
 *
 * Never initials. Those are asserted against explicitly because "show their
 * initials when there's no photo" is the obvious thing to reach for and was
 * what the phone did until 2026-08-20.
 *
 * The hostile-URL case is here rather than only in avatarUrl.test.ts because
 * this component is the last place a bad `image` could become an outbound
 * request from every viewer's browser.
 */

vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@/components/SupportModal', () => ({ default: () => null }));

const GOOGLE_USER = {
  name: 'Sam Shirley',
  email: 'samuelashirley@gmail.com',
  image: 'https://lh3.googleusercontent.com/a/photo.jpg',
};

const OTP_USER = { name: null, email: 'code-signin@example.com', image: null };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AppNavbar account button', () => {
  it('renders the Google photo when the session has one', () => {
    const { container } = render(<AppNavbar user={GOOGLE_USER} />);

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', GOOGLE_USER.image);
    // Google does not need to know which page of ours the user is on.
    expect(img).toHaveAttribute('referrerPolicy', 'no-referrer');
    // Decorative: the address is already on the button's aria-label.
    expect(img).toHaveAttribute('alt', '');
  });

  it('falls back to the glyph when a stored photo URL fails to load', () => {
    // Google avatar URLs rot when the user changes their picture, and ours is
    // only refreshed at their next sign-in. Without the onError fallback the
    // button shows a broken-image icon indefinitely.
    const { container } = render(<AppNavbar user={GOOGLE_USER} />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('refuses a photo URL that is not on Google\'s avatar host', () => {
    // Defence in depth: sanitizeAvatarUrl already gates the write, but a row
    // predating that rule must not become an outbound request either.
    const { container } = render(
      <AppNavbar user={{ ...GOOGLE_USER, image: 'https://evil.example.com/pixel.gif' }} />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('evil.example.com');
  });

  it('renders no initials for an email-code user — just the glyph', () => {
    render(<AppNavbar user={OTP_USER} />);
    const button = screen.getByRole('button', { name: /account menu/i });

    // "CS" / "C" would both come out of the old initials derivation.
    expect(button.textContent).toBe('');
    expect(button.querySelector('img')).toBeNull();
    expect(button.querySelector('svg')).not.toBeNull();
  });

  it('names the signed-in address in the button label, for screen readers', () => {
    render(<AppNavbar user={OTP_USER} />);
    expect(
      screen.getByRole('button', { name: /signed in as code-signin@example\.com/i }),
    ).toBeInTheDocument();
  });

  it('shows a "Signed in as" card on hover and hides it again on leave', () => {
    render(<AppNavbar user={OTP_USER} />);
    const button = screen.getByRole('button', { name: /account menu/i });
    const hoverTarget = button.parentElement as HTMLElement;

    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.mouseEnter(hoverTarget);
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Signed in as');
    expect(tip).toHaveTextContent('code-signin@example.com');

    fireEvent.mouseLeave(hoverTarget);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows the card on keyboard focus too — the old title tooltip never did', () => {
    render(<AppNavbar user={OTP_USER} />);
    const button = screen.getByRole('button', { name: /account menu/i });

    fireEvent.focus(button);
    expect(screen.getByRole('tooltip')).toHaveTextContent('code-signin@example.com');
  });

  it('suppresses the hover card while the menu is open — the menu says it already', () => {
    render(<AppNavbar user={OTP_USER} />);
    const button = screen.getByRole('button', { name: /account menu/i });
    const hoverTarget = button.parentElement as HTMLElement;

    fireEvent.mouseEnter(hoverTarget);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.click(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
    // The menu is what carries the address now.
    expect(screen.getByText('code-signin@example.com')).toBeInTheDocument();
  });

  it('labels the address in the open menu', () => {
    render(<AppNavbar user={GOOGLE_USER} />);
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }));

    expect(screen.getByText('Signed in as')).toBeInTheDocument();
    expect(screen.getByText('Sam Shirley')).toBeInTheDocument();
    expect(screen.getByText('samuelashirley@gmail.com')).toBeInTheDocument();
  });
});
