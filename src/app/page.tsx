import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { APP_STORE_URL } from '@/lib/paywallCopy';
import HeroVideo from '@/components/landing/HeroVideo';
import { LANDING_POSTER, LANDING_POSTER_HEIGHT, LANDING_POSTER_WIDTH } from '@/components/landing/config';
import { LANDING_COUNTRIES } from '@/components/landing/countries';
import { LANDING_SCREENSHOTS } from '@/components/landing/screenshots';
import styles from './page.module.css';

/**
 * The public landing page. What the app used to do at `/` (gate, then send
 * the visitor to /login or /trips) lives at /signin now.
 *
 * PUBLIC: no auth(), no requireWebAccess(). It is the page a stranger, a
 * crawler and an App Store reviewer all land on, and it has to render for
 * every one of them — listed in `webAccessCoverage.test.ts` as deliberately
 * ungated. Static, and the only client JS is the hero video.
 *
 * Claims are the MVP and nothing more (CLAUDE.md): Penny plans the days, Finn
 * finds fuel within range. No campgrounds, no groceries.
 */

const TITLE = 'Feral Travels: road trips planned by Penny';
const DESCRIPTION =
  'A road trip planner for iPhone. Penny lays your trip out day by day, and Finn finds fuel along the route before your tank runs low.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: 'Feral Travels',
    type: 'website',
    images: [
      {
        url: LANDING_POSTER,
        width: LANDING_POSTER_WIDTH,
        height: LANDING_POSTER_HEIGHT,
        alt: 'Penny running down a forest track',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: [LANDING_POSTER],
  },
};

const STEPS = [
  {
    title: 'Tell Penny the trip',
    body: "Where you start, where you're going, how long you have and how far you want to drive in a day.",
  },
  {
    title: 'She plans the days',
    body: "Every day's drive with its distance, drive time and a Google Maps link. Change your mind and she re-plans.",
  },
  {
    title: 'Finn finds fuel',
    body: "Gas stations along the route, placed so you never run dry before the next one. Set your vehicle's range once.",
  },
];

// What a user types, quoted in their own unit — not a distance the app rendered.
const PROMPTS = [
  "Two weeks around Spain's national parks in a 4×4, 400 km a day.", // units-literal-ok
  'Girona to Lisbon, leaving Tuesday, three days in Porto, no more than five hours driving a day.',
  'Denver to Zion by way of Moab. The van gets about 350 miles to a tank.',
  'Edinburgh to the Isle of Skye and back over a long weekend.',
];

export default function LandingPage() {
  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <Image
          className={styles.heroMedia}
          src={LANDING_POSTER}
          alt=""
          fill
          priority
          sizes="100vw"
        />
        <HeroVideo className={styles.heroMedia} />
        <div className={styles.bar}>
          <span className={styles.wordmark}>FERAL TRAVELS</span>
        </div>
        <div className={styles.heroBody}>
          <h1 className={styles.headline}>Tell Penny where you&apos;re going. She plans the drive.</h1>
          <p className={styles.lede}>{DESCRIPTION}</p>
          {/* Text, not Apple's logo: the logo is only allowed inside the official badge. */}
          <a href={APP_STORE_URL} className={styles.cta}>
            Get the app
          </a>
        </div>
      </header>

      <main>
        <section className={styles.section}>
          <p className={styles.kicker}>How it works</p>
          <h2 className={styles.h2}>Plan the route. Find the fuel.</h2>
          <ol className={styles.steps}>
            {STEPS.map((s, i) => (
              <li key={s.title} className={styles.step}>
                <span className={styles.stepNumber}>{i + 1}</span>
                <h3 className={styles.h3}>{s.title}</h3>
                <p className={styles.stepBody}>{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className={styles.section}>
          <p className={styles.kicker}>Say it like you&apos;d say it out loud</p>
          <h2 className={styles.h2}>Things people ask Penny</h2>
          <div className={styles.prompts}>
            {PROMPTS.map((p) => (
              <p key={p} className={styles.bubble}>
                &ldquo;{p}&rdquo;
              </p>
            ))}
          </div>
        </section>

        {LANDING_SCREENSHOTS.length > 0 && (
          <section className={styles.section}>
            <p className={styles.kicker}>In the app</p>
            <h2 className={styles.h2}>Two weeks in Spain&apos;s national parks</h2>
            <div className={styles.shots}>
              {LANDING_SCREENSHOTS.map((s) => (
                <Image
                  key={s.src}
                  className={styles.shot}
                  src={s.src}
                  alt={s.alt}
                  width={s.width}
                  height={s.height}
                  sizes="(max-width: 760px) 70vw, 340px"
                />
              ))}
            </div>
          </section>
        )}

        <section className={styles.section}>
          <p className={styles.kicker}>Named after</p>
          <h2 className={styles.h2}>Penny and Finn</h2>
          <div className={styles.dogs}>
            <figure className={styles.dog}>
              <Image
                className={styles.dogPhoto}
                src="/landing/penny.jpg"
                alt="Penny, a blue merle Australian Shepherd"
                width={512}
                height={512}
                sizes="(max-width: 760px) 45vw, 260px"
              />
              <figcaption>
                <b className={styles.dogName}>Penny</b>
                <span className={styles.dogRole}>Plans the trip.</span>
              </figcaption>
            </figure>
            <figure className={styles.dog}>
              <Image
                className={styles.dogPhoto}
                src="/landing/finn.jpg"
                alt="Finn, a black and white long-haired dog"
                width={640}
                height={640}
                sizes="(max-width: 760px) 45vw, 260px"
              />
              <figcaption>
                <b className={styles.dogName}>Finn</b>
                <span className={styles.dogRole}>Finds the fuel.</span>
              </figcaption>
            </figure>
          </div>
        </section>

        <section className={styles.section}>
          <p className={styles.kicker}>Available in</p>
          <h2 className={styles.h2}>{LANDING_COUNTRIES.length} countries</h2>
          <ul className={styles.countries}>
            {LANDING_COUNTRIES.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </section>
      </main>

      <footer className={styles.footer}>
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/support">Support</Link>
        <span className={styles.footerName}>Feral Travels</span>
      </footer>
    </div>
  );
}
