'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import clsx from 'clsx';

interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: 'success' | 'error' | 'info';
}

interface ToastContextValue {
  readonly addToast: (message: string, tone?: Toast['tone']) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    setToasts((current) => {
      const next = [...current, { id: Date.now() + Math.random(), message, tone }];
      return next.slice(-4);
    });
    setTimeout(() => {
      setToasts((current) => current.slice(1));
    }, 3500);
  }, []);

  const value = useMemo(() => ({ addToast }), [addToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={clsx('toast', toast.tone)}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}
