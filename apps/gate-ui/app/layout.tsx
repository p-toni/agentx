import './globals.css';
import type { ReactNode } from 'react';
import { AuthProvider } from '../components/auth-context';
import { ToastProvider } from '../components/toast-context';
import { AppShell } from '../components/app-shell';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <ToastProvider>
            <AppShell>{children}</AppShell>
          </ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
