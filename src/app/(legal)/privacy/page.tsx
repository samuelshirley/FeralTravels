import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy — Feral Travels',
  description: 'What Feral Travels collects, why, who else sees it, and how to delete all of it.',
};

const UPDATED = '20 October 2026';
const CONTACT = 'sam@feraltravels.com';

/**
 * Written to be read, not to be survived.
 *
 * GDPR Article 12 asks for "concise, transparent, intelligible and easily
 * accessible form, using clear and plain language" — the dense legal register
 * everyone else uses is over-compliance out of fear, not the standard. So this
 * page is in the first person, says what is actually true, and leads with what
 * is NOT done, because that is the part a reader wants and never gets.
 *
 * It still carries every Article 13 disclosure: controller identity, what is
 * collected, purposes, legal bases, recipients, transfers outside the EEA,
 * retention, the rights list, and the right to complain to a supervisory
 * authority. Plain does not mean incomplete — if a section below reads like it
 * could be cut, check it against Article 13 first.
 *
 * Two rules for anyone editing this file:
 *
 *  1. **Never describe behaviour the code does not have.** A privacy policy
 *     that overpromises is worse than a wordy one. The retention section says
 *     error and usage records are kept indefinitely because nothing prunes them
 *     — when a sweeper exists, change the sentence then, not before.
 *  2. **Change it when the code changes.** Every claim here is checkable
 *     against something: DeviceLocationContext for the location section,
 *     repos/accountDeletion.ts for what a deletion leaves behind,
 *     lib/avatarUrl.ts for the profile picture.
 *
 * "Who else sees it" is checked the same way, one provider at a time, and
 * `legalPagesGuard.test.ts` fails if a name drops off it:
 *   Anthropic   — lib/claude.ts (Penny: messages, photos, penny/context.ts with
 *                 device_location), server/onboarding.ts → parseStartDate,
 *                 parseRangeEstimate, onboardingIntentScan; server/messageGate.ts.
 *                 No email or name is in any of those payloads.
 *   RevenueCat  — mobile/lib/purchases.ts `Purchases.logIn(users.id)`; nothing
 *                 else is set on the customer. Webhook: api/webhooks/revenuecat.
 *   Apple       — StoreKit (the charge), mobile/lib/oauth.ts (Sign in with
 *                 Apple), server/auth/appleTokens.ts (revoke on deletion),
 *                 mobile/lib/location.tsx (reverse geocode via expo-location),
 *                 mobile/components/TripMap.tsx (Apple Maps: no Google key).
 *   Google      — lib/google/* server-side, lib/reverseGeocode.ts (web only).
 *   Resend      — auth/otp-email.ts, api/support, payments/alerts.ts.
 *   Nominatim   — lib/osm/nominatim.ts, from claude.ts's split-point naming.
 *   Vercel      — hosting, and <Analytics /> in app/layout.tsx (web only).
 */
export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy</h1>
      <p className="updated">Last updated {UPDATED}</p>

      <p>
        <strong>The short version: you are not the product.</strong> I don&apos;t sell your
        data. I don&apos;t advertise to you. Nobody pays me to put anything in front of you,
        and nothing you tell Penny is used to train anything or build a profile of you.
        Feral Travels collects what it needs to plan your trip and not much else, and you
        can delete every bit of it yourself, from Settings, in about ten seconds.
      </p>
      <p>
        That&apos;s the deal. The rest of this page is the detail — partly because the law
        asks for it, mostly so you can check I&apos;m telling the truth.
      </p>
      <p>
        Feral Travels is run by one person: me, Samuel Shirley, in Spain. That makes me the
        data controller for everything below. If any of it bothers you, email{' '}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a> — a human reads it. This covers
        feraltravels.com and the iOS app; they&apos;re one service, one account, one
        database.
      </p>

      <h2>What I hold</h2>
      <ul>
        <li>
          <strong>Your email address.</strong> That&apos;s your account. There&apos;s no
          password — you sign in with a code I email you, or with Google or Apple.
        </li>
        <li>
          <strong>Your name and profile picture</strong>, if you signed in with Google or
          Apple and they handed them over. The picture itself stays on Google&apos;s
          servers; I only keep the web address of it, and your phone or browser fetches the
          image from Google when it shows your account icon. Apple never provides a
          picture, so Apple accounts get a plain grey person icon.
        </li>
        <li>
          <strong>Your trips.</strong> Everything you put in: where you&apos;re going, when,
          the stops, the routes, notes and costs. This is the product.
        </li>
        <li>
          <strong>Your vehicle.</strong> Its name, fuel type, and how far it goes on a tank.
          That last number is what the whole fuel-stop plan is built on.
        </li>
        <li>
          <strong>Where you are</strong> — two different things, and they&apos;re worth
          keeping apart:
          <ul>
            <li>
              <em>Your phone&apos;s position</em>, if you allow it, while a trip is open on
              screen. It&apos;s what makes &quot;plan from where I am&quot; work without you
              typing coordinates. I keep the most recent one and overwrite it with the next.
              There is no history of where you&apos;ve been, and nothing is collected when
              the app is closed or in the background.
            </li>
            <li>
              <em>The places in your plan</em> — the coordinates of every start point,
              destination and stop, and the dates you expect to be there. That&apos;s kept
              for as long as the trip is, because it <strong>is</strong> the trip.
            </li>
          </ul>
        </li>
        <li>
          <strong>What you say to Penny</strong>, and what she says back, including any
          photos you attach.
        </li>
        <li>
          <strong>Your plan</strong>, if you subscribe: which one, when it renews or ends,
          and Apple&apos;s transaction numbers for it. Never your card — Apple takes the
          payment and I don&apos;t see how you paid.
        </li>
        <li>
          <strong>The plumbing:</strong> sign-in sessions, the one-time codes, which screens
          were open and for how long, and errors. This is how I keep the thing working and
          stop the AI bill getting away from me.
        </li>
      </ul>

      <h2>Why</h2>
      <p>
        Because you asked me to plan a trip and I can&apos;t do it without these things.
        That&apos;s the legal basis for nearly all of it: performing the contract you
        entered into when you signed up.
      </p>
      <p>
        The error and usage records are the exception — I keep those on the basis of a
        legitimate interest in the app not being broken and not bankrupting me. If you want
        to object to that specifically, you can, and you should say so.
      </p>
      <p>
        Sign-in codes go out because you asked for one. No advertising, no profiling,
        nothing sold or rented. Not now — and if that ever changes, it will not change
        quietly.
      </p>

      <h2>Who else sees it</h2>
      <p>Only the companies needed to run this, each for the job named here:</p>
      <ul>
        <li>
          <strong>Anthropic (Claude)</strong> — the AI that runs Penny. To write her
          replies it gets your messages, the photos you attach, and the trip context she
          needs to answer: your itinerary, your vehicle, and your phone&apos;s current
          position when you&apos;ve shared it. It also reads your answers to the trip set-up
          questions when they&apos;re typed in your own words, like a start date or how far
          your vehicle goes. It does not get your email address or your name.{' '}
          <strong>The app asks your permission before anything is sent to Anthropic</strong>,
          and nothing goes until you say yes.
        </li>
        <li>
          <strong>Apple</strong> — takes the payment when you subscribe, through the App
          Store, and handles renewals, cancellations and refunds. Sign in with Apple, if you
          use it: Apple gives me your email address, or a private relay address if you chose
          one, and your name if you let it. When you delete your account I tell Apple to
          revoke that sign-in. In the iOS app, Apple also draws the map and turns your
          phone&apos;s position into a place name.
        </li>
        <li>
          <strong>RevenueCat</strong> — keeps track of App Store subscriptions for me. It
          gets your account&apos;s ID, a random number rather than your email or name, and
          your purchase events from Apple: which plan, the price, the dates, and
          Apple&apos;s transaction numbers. It tells my server when you subscribe, renew,
          cancel or get a refund.
        </li>
        <li>
          <strong>Google</strong> — routes, road distances, and place and fuel-station
          searches, done from my server. Those get the coordinates and place names in your
          plan, including your phone&apos;s position when a route starts from where you
          are, and nothing that identifies you. On the website, Google also draws the map
          and turns your position into a place name. Google sign-in, if you use it: Google
          gives me your email address, your name and the web address of your profile
          picture.
        </li>
        <li>
          <strong>OpenStreetMap (Nominatim)</strong> — turns a coordinate back into a town
          name when a long driving day is split. Coordinates only.
        </li>
        <li>
          <strong>Resend</strong> — sends email. It gets your address to send your sign-in
          codes. It also carries anything you send from the support form to me, with your
          name and email address so I can reply, and a note to me if an account&apos;s AI
          costs pass a limit, which names that account&apos;s email address.
        </li>
        <li>
          <strong>Neon</strong> — hosts the database all of this sits in.
        </li>
        <li>
          <strong>Vercel</strong> — hosts the website and the server the app talks to, so
          every request passes through it. On the website it also counts visits, without
          cookies.
        </li>
        <li>
          <strong>Expo</strong> — builds the iOS app and delivers its updates. It sees which
          version of the app your phone is running, not who you are.
        </li>
      </ul>
      <p>
        Some of them process data outside the European Economic Area. Where that happens,
        the transfer relies on that provider&apos;s standard contractual clauses or an
        equivalent safeguard.
      </p>

      <h2>How long I keep it</h2>
      <ul>
        <li>
          <strong>Your account and trips:</strong> until you delete them.
        </li>
        <li>
          <strong>Sign-in codes:</strong> ten minutes, or the second you use one.
        </li>
        <li>
          <strong>Sign-in sessions:</strong> 30 days, or until you sign out.
        </li>
        <li>
          <strong>Your plan:</strong> until you delete your account. The purchase notices
          behind it are kept after that — see below.
        </li>
        <li>
          <strong>Errors, usage records, and the log of each request to Penny:</strong>{' '}
          right now, indefinitely. There is no automatic clear-out yet, and I&apos;d rather
          say so than claim one exists. They go when your account goes.
        </li>
      </ul>

      <h2>Deleting everything</h2>
      <p>
        Settings → Delete account, on the web or in the app. Type the words and it&apos;s
        gone: immediately, no waiting period, no undo. Trips and their locations, routes,
        stops, fuel plans, vehicles, tasks, conversations with Penny, the address of your
        picture, and your sign-in details all go at once. You don&apos;t have to email
        anyone, explain yourself, or click through a screen trying to talk you out of it.
      </p>
      <p>
        Deleting your account does not cancel an App Store subscription. Apple bills it, so
        cancel it in your Apple Account settings as well.
      </p>
      <p>Three things outlive the deletion, and I&apos;d rather tell you than have you find out:</p>
      <ul>
        <li>
          <strong>A record that the account existed.</strong> It holds when the account was
          created and deleted, whether you signed in by emailed code, Google or Apple, and
          how many trips, vehicles and Penny messages you had. It also holds your email
          address twice over: once as a one-way fingerprint that can&apos;t be turned back
          into an address, and once encrypted — and I can decrypt that second one from the
          admin page. It&apos;s there so a deletion can be evidenced if you ever ask me to
          prove it, and so I can see how many people leave. If you&apos;d rather that record
          didn&apos;t exist either, email me and I&apos;ll remove it.
        </li>
        <li>
          <strong>Cost and usage rows,</strong> unlinked from you, so I can still see what
          the service costs to run. Any text in them that could carry something you wrote or
          somewhere you drove is erased at the same time.
        </li>
        <li>
          <strong>Purchase notices,</strong> if you ever subscribed: the messages Apple and
          RevenueCat sent about your plan — which plan, the price, the dates and the
          transaction numbers. They carry your old account&apos;s ID number but not your
          email address or name, and they&apos;re kept so a payment can still be traced if
          there&apos;s ever a question about it.
        </li>
      </ul>

      <h2>What else you can ask for</h2>
      <p>
        Under the GDPR you can ask for a copy of everything I hold about you, have something
        wrong corrected, take it elsewhere in a portable file, or object to the
        legitimate-interest parts. Email <a href={`mailto:${CONTACT}`}>{CONTACT}</a> and
        you&apos;ll have an answer within 30 days.
      </p>
      <p>
        If I handle that badly, you can complain to the Spanish data protection authority,
        the{' '}
        <a href="https://www.aepd.es" target="_blank" rel="noreferrer">
          Agencia Española de Protección de Datos
        </a>
        , or to the equivalent authority where you live. That&apos;s your right, and
        I&apos;d rather you used it than stayed annoyed.
      </p>

      <h2>Under 16</h2>
      <p>
        Feral Travels isn&apos;t built for you, and accounts aren&apos;t knowingly created
        for under-16s.
      </p>

      <h2>If this changes</h2>
      <p>
        The date at the top changes. Anything that actually affects you, you&apos;ll be told
        in the app before it takes effect — not buried in a commit.
      </p>
    </>
  );
}
