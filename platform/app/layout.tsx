import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { getSession } from '@/lib/session';
import { ENV } from '@/lib/env';

export const metadata: Metadata = {
  title: 'R2 Storage — Managed S3-compatible object storage',
  description: 'Per-tenant, white-label S3/R2-compatible object storage on your own domain.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  const brand = `storage.${ENV.PLATFORM_DOMAIN}`;

  return (
    <html lang="en">
      <body>
        <nav className="nav">
          <Link href="/" className="brand">
            {brand}
          </Link>
          <div className="spacer" />
          {session ? (
            <>
              {session.role === 'operator' && <Link href="/admin">Admin</Link>}
              <Link href="/dashboard">Dashboard</Link>
              <form action="/api/auth/logout" method="post">
                <button className="secondary" type="submit">
                  Log out
                </button>
              </form>
            </>
          ) : (
            <>
              <Link href="/login">Log in</Link>
              <Link href="/signup">Sign up</Link>
            </>
          )}
        </nav>
        {children}
      </body>
    </html>
  );
}
