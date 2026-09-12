"use client";

import { CircleAlert, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

interface ToastOptions { action?: { label: string; onClick: () => void } }
interface Toast extends ToastOptions { id: number; message: string }
const ToastContext = createContext<(message: string, options?: ToastOptions) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const notify = useCallback((message: string, options?: ToastOptions) => {
    const toast = { id: ++nextId.current, message, ...options };
    setToasts((current) => [...current.filter((item) => item.message !== message), toast].slice(-5));
  }, []);
  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((item) => item.id !== id)), []);
  return <ToastContext.Provider value={notify}>{children}
    <div className="toast-stack" aria-label="Notifications">{toasts.map((toast) => <ToastItem key={toast.id} toast={toast} dismiss={dismiss} />)}</div>
  </ToastContext.Provider>;
}
function ToastItem({ toast, dismiss }: { toast: Toast; dismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => dismiss(toast.id), 6000);
    return () => clearTimeout(timer);
  }, [toast.id, dismiss]);
  return <div className="app-toast" role="alert">
    <CircleAlert className="toast-icon" size={18} aria-hidden="true" />
    <div className="toast-content"><p>{toast.message}</p>{toast.action && <button className="toast-action" onClick={() => { toast.action?.onClick(); dismiss(toast.id); }}>{toast.action.label}</button>}</div>
    <button className="toast-dismiss" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)}><X size={16} aria-hidden="true" /></button>
  </div>;
}
export function useToast() { return useContext(ToastContext); }

export function ToastMessage({ message }: { message: string | null }) {
  const notify = useToast();
  useEffect(() => { if (message) notify(message); }, [message, notify]);
  return null;
}
