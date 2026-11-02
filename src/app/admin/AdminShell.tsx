import Link from 'next/link';
import AppNavbar from '@/components/AppNavbar';
import styles from './admin.module.css';

export interface AdminShellUser {
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

/**
 * The frame every /admin screen shares: navbar, a breadcrumb back to the tile
 * map, and the heading. Each page still gates itself (`requireWebAccess()` +
 * `isAdmin`) before rendering this — the shell is layout, not access control.
 */
export default function AdminShell({
  user,
  title,
  count,
  subtitle,
  home = false,
  children,
}: {
  /** The tile map itself — no breadcrumb back to where you already are. */
  home?: boolean;
  user: AdminShellUser;
  title: string;
  /** Printed next to the heading, e.g. "12 total". */
  count?: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.wrapper}>
      <AppNavbar user={{ name: user.name, email: user.email, image: user.image }} isAdmin />
      <main className={styles.main}>
        {!home && (
          <nav aria-label="Breadcrumb" className={styles.crumb}>
            <Link href="/admin" className={styles.seeAllLink}>
              Admin
            </Link>
            {' / '}
            {title}
          </nav>
        )}
        <header className={styles.pageHeader}>
          <h1 className={styles.pageTitle}>
            {title}
            {count && <span className={styles.pageCount}>{count}</span>}
          </h1>
          {subtitle && <p className={styles.pageSubtitle}>{subtitle}</p>}
        </header>
        {children}
      </main>
    </div>
  );
}
