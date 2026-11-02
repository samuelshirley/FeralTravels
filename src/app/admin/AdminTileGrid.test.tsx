/**
 * The rendered tile map: every tile is a link to its screen, provider tiles
 * open the provider's console in a new tab, and every tile is the same box —
 * one size class, no inline style — however long its text.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';
import AdminTileGrid from './AdminTileGrid';
import { buildAdminSections } from './tiles';
import styles from './AdminTiles.module.css';
import { dashboardFixture } from '@/test/adminDashboardFixture';

afterEach(cleanup);

describe('AdminTileGrid', () => {
  it('renders every section with its tiles, new signups first', () => {
    render(<AdminTileGrid sections={buildAdminSections(dashboardFixture())} />);
    const growth = screen.getByTestId('admin-section-growth');
    expect(within(growth).getByRole('heading', { name: 'Growth' })).toBeInTheDocument();
    const links = within(growth).getAllByRole('link');
    expect(links[0]).toHaveAttribute('data-testid', 'admin-tile-new-signups');
    expect(links[0]).toHaveTextContent('New signups · 24h');
    expect(links[0]).toHaveTextContent('12');
    expect(links[0]).toHaveTextContent('61 in 7d');
  });

  it('every tile is a link with an href — no tile is a dead end', () => {
    const sections = buildAdminSections(dashboardFixture());
    render(<AdminTileGrid sections={sections} />);
    const tiles = sections.flatMap((s) => s.tiles);
    for (const t of tiles) {
      const el = screen.getByTestId(`admin-tile-${t.id}`);
      expect(el.tagName).toBe('A');
      expect(el).toHaveAttribute('href', t.href);
    }
  });

  it('provider tiles open the provider console in a new tab; internal ones do not', () => {
    render(<AdminTileGrid sections={buildAdminSections(dashboardFixture())} />);
    const ai = screen.getByTestId('admin-tile-ai-spend-today');
    expect(ai).toHaveAttribute('href', 'https://platform.claude.com/cost');
    expect(ai).toHaveAttribute('target', '_blank');
    expect(ai).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByTestId('admin-tile-google-billable')).toHaveAttribute('target', '_blank');
    expect(screen.getByTestId('admin-tile-new-signups')).not.toHaveAttribute('target');
  });

  it('every tile has exactly the size class plus one tone class, and no inline style — even with very long text', () => {
    const long = 'x'.repeat(400);
    const sections = buildAdminSections(
      dashboardFixture({
        anthropic: { status: 'error', message: long },
        topSpender: { ok: true, value: { name: long, email: null, microcents: 1 } },
      })
    );
    render(<AdminTileGrid sections={sections} />);
    for (const t of sections.flatMap((s) => s.tiles)) {
      const el = screen.getByTestId(`admin-tile-${t.id}`);
      expect(el.className).toBe(`${styles.tile} ${styles[`tone_${t.tone}`]}`);
      expect(el).not.toHaveAttribute('style');
    }
  });

  it('carries the untruncated text in the title, so the ellipsis hides nothing', () => {
    render(
      <AdminTileGrid
        sections={buildAdminSections(dashboardFixture({ google: { status: 'error', message: 'BigQuery query HTTP 403: Access Denied on a long table name' } }))}
      />
    );
    expect(screen.getByTestId('admin-tile-google-billable')).toHaveAttribute(
      'title',
      'Google · this month: Error — BigQuery query HTTP 403: Access Denied on a long table name'
    );
  });
});
