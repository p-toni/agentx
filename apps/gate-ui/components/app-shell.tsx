'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { PropsWithChildren, useCallback } from 'react';
import { useAuth } from './auth-context';

export function AppShell({ children }: PropsWithChildren) {
  const { user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const handleLogout = useCallback(() => {
    logout();
    router.push('/login');
  }, [logout, router]);

  return (
    <div className="app-shell">
      <header>
        <div className="branding">
          <Link href="/bundles" prefetch={false}>
            Gate Console
          </Link>
        </div>
        <nav>
          <Link href="/bundles" prefetch={false} className={pathname?.startsWith('/bundles') ? 'active' : ''}>
            Bundles
          </Link>
        </nav>
        <div className="user">
          {user ? (
            <>
              <span>{user}</span>
              <button type="button" onClick={handleLogout}>
                Logout
              </button>
            </>
          ) : (
            <Link href="/login" prefetch={false}>
              Login
            </Link>
          )}
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
