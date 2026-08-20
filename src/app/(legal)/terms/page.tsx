import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service — Feral Travels',
  description: 'The terms you agree to by using Feral Travels, including the limits of its routing and fuel estimates.',
};

const UPDATED = '19 August 2026';
const CONTACT = 'samuelashirley@gmail.com';

export default function TermsPage() {
  return (
    <>
      <h1>Terms of Service</h1>
      <p className="updated">Last updated {UPDATED}</p>

      <p>
        Feral Travels is operated by Samuel Shirley, an individual based in Spain
        (&quot;we&quot;). By creating an account or using the website or the iOS app, you
        agree to these terms. If you do not, do not use the service.
      </p>

      <h2>What the service is</h2>
      <p>
        Feral Travels helps you plan and follow long road trips: routes, daily legs, stops,
        vehicles, and fuel planning, with an assistant called Penny you can talk to.
      </p>

      <h2>Your account</h2>
      <p>
        You sign in with your email address or with Google or Apple. One email address is
        one account. Keep access to that email secure — anyone who can read it can sign in
        as you. Tell us at <a href={`mailto:${CONTACT}`}>{CONTACT}</a> if you think someone
        else has got into your account.
      </p>

      <h2>Routing, fuel and range figures are estimates</h2>
      <p>
        <strong>
          This is the most important thing on this page. Distances, drive times, fuel
          ranges, and suggested refuelling points are estimates produced from map data and
          from the vehicle figures you enter. They are decision support, not a guarantee.
        </strong>
      </p>
      <p>
        Map data goes out of date. Fuel stations close, run dry, or turn out to be card-only
        at 3am. Real consumption varies with load, weather, terrain and how you drive. On
        long unserviced stretches the margin between a plan and a problem is thin, and it is
        yours to manage.
      </p>
      <p>
        You remain solely responsible for your own driving decisions, for carrying enough
        fuel, and for your safety and that of your passengers. Verify anything that matters
        before you rely on it.
      </p>

      <h2>Your content</h2>
      <p>
        Your trips, notes, photos and messages remain yours. You grant us only the
        permission needed to run the service for you — storing that content, and sending
        the relevant parts to the providers listed in the{' '}
        <Link href="/privacy">Privacy Policy</Link>, such as sending your messages to
        Anthropic so Penny can reply. Nothing is published or shared with other users.
      </p>

      <h2>Acceptable use</h2>
      <p>Do not use Feral Travels to:</p>
      <ul>
        <li>break the law, or help anyone else do so;</li>
        <li>upload content you have no right to upload;</li>
        <li>
          attack, overload, scrape or reverse-engineer the service, or work around its rate
          limits;
        </li>
        <li>access anyone else&apos;s account or data.</li>
      </ul>
      <p>
        Accounts doing any of the above may be suspended or removed, with notice where it
        is practical to give it.
      </p>

      <h2>Availability</h2>
      <p>
        The service is currently free and provided as-is. There is no uptime guarantee,
        features may change or be removed, and it depends on third-party providers that can
        fail independently of us. If the service is ever discontinued, you will be given
        reasonable notice and a way to export your trips.
      </p>

      <h2>Liability</h2>
      <p>
        To the fullest extent permitted by law, we are not liable for any loss arising from
        reliance on route, fuel or timing information, for lost data, or for indirect or
        consequential loss. Nothing in these terms limits liability that cannot be limited
        by law, including for death or personal injury caused by negligence, or for fraud.
      </p>
      <p>
        As a consumer, you keep all the rights Spanish and EU consumer law gives you; these
        terms do not take them away.
      </p>

      <h2>Ending it</h2>
      <p>
        You can stop using the service and ask for your account and data to be deleted at
        any time — email <a href={`mailto:${CONTACT}`}>{CONTACT}</a>. We may close an
        account that breaches these terms.
      </p>

      <h2>Changes</h2>
      <p>
        These terms may be updated. The date at the top changes, and for anything
        significant you will be told in the app before it takes effect. Continuing to use
        the service after that means you accept the change.
      </p>

      <h2>Governing law</h2>
      <p>
        These terms are governed by Spanish law, and disputes fall to the Spanish courts,
        without affecting any right you have as a consumer to bring proceedings where you
        live.
      </p>

      <h2>Contact</h2>
      <p>
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
      </p>
    </>
  );
}
