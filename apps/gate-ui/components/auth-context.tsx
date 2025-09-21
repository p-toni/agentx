'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

interface AuthValue {
  readonly user: string | null;
  readonly isReady: boolean;
  readonly login: (username: string) => void;
  readonly logout: () => void;
}

const AuthContext = createContext<AuthValue | undefined>(undefined);
const STORAGE_KEY = 'gate-ui:user';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<string | null>(null);
  const [isReady, setReady] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      setReady(true);
      return;
    }
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) {
        setUser(stored);
      }
    } catch {
      // ignore storage errors
    }
    setReady(true);
  }, []);

  const login = useCallback((username: string) => {
    setUser(username);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(STORAGE_KEY, username);
      } catch {
        // ignore
      }
    }
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  }, []);

  const value = useMemo(() => ({ user, isReady, login, logout }), [user, isReady, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
