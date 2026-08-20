import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy — Feral Travels',
  description: 'What Feral Travels collects, why, who it is shared with, and how to get it deleted.',
};

const UPDATED = '19 August 2026';
const CONTACT = 'samuelashirley@gmail.com';

export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="updated">Last updated {UPDATED}</p>

      <p>
        Feral Travels is run by Samuel Shirley, an individual based in Spain, who is the
        data controller for everything described here. Questions, requests, or complaints:{' '}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>
      <p>
        This policy covers the website at feraltravels.com and the Feral Travels iOS app.
        They are one service sharing one account and one database.
      </p>

      <h2>What is collected</h2>
      <ul>
        <li>
          <strong>Your account.</strong> Your email address, which is the identity of the
          account. If you sign in with Google or Apple, whatever display name they return
          on first sign-in. No password is ever collected — sign-in is a one-time emailed
          code, or Google/Apple.
        </li>
        <li>
          <strong>Settings.</strong> Your units preference, and your timezone, captured
          from your browser or device so that &quot;today&quot; means the same day where you
          actually are.
        </li>
        <li>
          <strong>Your trips.</strong> Everything you put in: trip titles and dates, legs,
          stops, routes, notes, costs, points of interest, links, and any GPX files you
          upload.
        </li>
        <li>
          <strong>Your vehicles.</strong> The details you enter, including fuel consumption
          and range figures used to plan fuel stops.
        </li>
        <li>
          <strong>Location.</strong> Your position when you report it during a trip, used
          to anchor where you have got to and to plan the fuel stops ahead of you. Position
          is recorded when you send it; the app does not track you in the background.
        </li>
        <li>
          <strong>Conversations with Penny.</strong> The messages you send and the replies
          you get, including any photos you attach.
        </li>
        <li>
          <strong>Technical and usage records.</strong> Sign-in sessions, one-time codes,
          which screens are open and for how long, and errors, used to keep the service
          working and to control the cost of the AI features.
        </li>
      </ul>

      <h2>Why, and on what legal basis</h2>
      <ul>
        <li>
          To provide the service you asked for — planning trips, routing, fuel stops,
          answering you as Penny. Legal basis: performance of a contract with you.
        </li>
        <li>
          To keep the service secure and working, diagnose faults, and prevent abuse.
          Legal basis: legitimate interests.
        </li>
        <li>
          To send you the sign-in codes you request. Legal basis: performance of a
          contract with you.
        </li>
      </ul>
      <p>
        There is no advertising, no profiling for marketing, and your data is not sold or
        rented to anybody.
      </p>

      <h2>Who it is shared with</h2>
      <p>
        Only the providers needed to run the service, each for the stated purpose and
        nothing else:
      </p>
      <ul>
        <li>
          <strong>Anthropic</strong> — your messages to Penny, and the trip context she
          needs to answer, are sent to Anthropic&apos;s API to generate her replies.
        </li>
        <li>
          <strong>Google</strong> — maps, directions and place lookups, and Google sign-in
          if you use it.
        </li>
        <li>
          <strong>Apple</strong> — Sign in with Apple, if you use it.
        </li>
        <li>
          <strong>Resend</strong> — sends your sign-in code emails.
        </li>
        <li>
          <strong>Neon</strong> — hosts the database everything is stored in.
        </li>
        <li>
          <strong>Vercel</strong> — hosts the website and collects aggregate, cookie-free
          traffic analytics.
        </li>
        <li>
          <strong>OpenStreetMap (Overpass) and OSRM</strong> — fuel station and road
          routing lookups. These receive coordinates only, never anything identifying you.
        </li>
        <li>
          <strong>Expo</strong> — builds and delivers updates to the iOS app.
        </li>
      </ul>
      <p>
        Some of these providers process data outside the European Economic Area. Where they
        do, the transfer relies on the provider&apos;s standard contractual clauses or an
        equivalent safeguard.
      </p>

      <h2>How long it is kept</h2>
      <ul>
        <li>Your account and trip data: until you delete it, or ask for the account to be deleted.</li>
        <li>Sign-in codes: deleted once used, and in any case after 10 minutes.</li>
        <li>Sign-in sessions: 30 days, or until you sign out.</li>
        <li>Error and usage records: kept while they are useful for diagnosing problems, then discarded.</li>
        <li>
          After you delete your account: a single record that an account on your email address
          existed and when it was deleted, together with counts of how many trips and vehicles it
          had. The address itself is stored encrypted and as a one-way hash, and is kept so that a
          deletion can be evidenced and to understand how many people leave. Everything else — your
          trips, routes, stops, vehicles, conversations and sign-in details — is deleted immediately
          and permanently.
        </li>
      </ul>

      <h2>Your rights</h2>
      <p>
        Under the GDPR you can ask for a copy of your data, correct it, have it deleted,
        take it elsewhere in a portable form, or object to processing based on legitimate
        interests. Email <a href={`mailto:${CONTACT}`}>{CONTACT}</a> and it will be handled
        within 30 days.
      </p>
      <p>
        You can delete your account yourself at any time, from Settings in the app or on the web.
        It happens immediately, there is no waiting period, and it cannot be undone — your trips,
        routes, stops, fuel plans, vehicles, conversations and sign-in details are removed from the
        database at once. The one exception is the deletion record described above, and anonymous
        usage and cost records that are no longer linked to you.
      </p>
      <p>
        If you are not satisfied with the response, you can complain to the Spanish data
        protection authority, the{' '}
        <a href="https://www.aepd.es" target="_blank" rel="noreferrer">
          Agencia Española de Protección de Datos
        </a>
        , or to the supervisory authority where you live.
      </p>

      <h2>Children</h2>
      <p>
        Feral Travels is not intended for anyone under 16, and accounts are not knowingly
        created for them.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes in a way that affects you, the date at the top changes and,
        for anything significant, you will be told in the app before it takes effect.
      </p>
    </>
  );
}
