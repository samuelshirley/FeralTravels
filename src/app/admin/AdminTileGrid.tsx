import Link from 'next/link';
import { isExternalHref, type AdminSection, type AdminTile } from './tiles';
import styles from './AdminTiles.module.css';

/**
 * Renders the homepage tile map. Every tile is a link — internal tiles through
 * `next/link`, provider consoles in a new tab — and every tile is the same box:
 * ONE class, no `style` prop, text truncated by CSS (`adminTilesGuard.test.ts`).
 * The `title` carries the untruncated text, so nothing is lost to the ellipsis.
 */
export default function AdminTileGrid({ sections }: { sections: AdminSection[] }) {
  return (
    <div className={styles.sections}>
      {sections.map((section) => (
        <section key={section.id} aria-labelledby={`admin-section-${section.id}`} data-testid={`admin-section-${section.id}`}>
          <h2 id={`admin-section-${section.id}`} className={styles.sectionTitle}>
            {section.title}
          </h2>
          <div className={styles.grid}>
            {section.tiles.map((t) => (
              <TileLink key={t.id} tile={t} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function TileLink({ tile }: { tile: AdminTile }) {
  const external = isExternalHref(tile.href);
  const body = (
    <>
      <span className={styles.label}>
        {tile.label}
        {external && (
          <span className={styles.external} aria-hidden="true">
            ↗
          </span>
        )}
      </span>
      <span className={styles.value}>{tile.value}</span>
      <span className={styles.sub}>{tile.sub}</span>
    </>
  );
  // The size class is the same for every tile; the tone class only recolours.
  const className = `${styles.tile} ${styles[`tone_${tile.tone}`]}`;
  const title = `${tile.label}: ${tile.value}${tile.sub ? ` — ${tile.sub}` : ''}`;
  if (external) {
    return (
      <a href={tile.href} className={className} data-testid={`admin-tile-${tile.id}`} title={title} target="_blank" rel="noopener noreferrer">
        {body}
      </a>
    );
  }
  return (
    <Link href={tile.href} className={className} data-testid={`admin-tile-${tile.id}`} title={title}>
      {body}
    </Link>
  );
}
