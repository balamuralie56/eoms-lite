import {
  createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Info, Loader2, X, XCircle } from 'lucide-react';

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

/* ------------------------------------------------------------------ buttons / fields */

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-blue-700 text-white hover:bg-blue-800 focus-visible:outline-blue-700 disabled:bg-blue-300',
  secondary: 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 focus-visible:outline-blue-700 disabled:text-slate-400',
  danger: 'bg-red-700 text-white hover:bg-red-800 focus-visible:outline-red-700 disabled:bg-red-300',
  ghost: 'text-slate-700 hover:bg-slate-100 focus-visible:outline-blue-700 disabled:text-slate-400',
};

export function Button({ variant = 'primary', size = 'md', loading, className, children, disabled, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean }) {
  const sz = size === 'sm' ? 'px-3 py-1.5 text-sm' : size === 'lg' ? 'px-6 py-3.5 text-lg' : 'px-4 py-2 text-sm';
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx('inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors outline-offset-2 focus-visible:outline-2 disabled:cursor-not-allowed', sz, VARIANTS[variant], className)}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

const fieldCls = 'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-blue-700 focus:outline-2 focus:outline-offset-0 focus:outline-blue-700 disabled:bg-slate-100';

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-800">{label}</label>
      {children}
      {hint && !error && <p className="text-xs text-slate-600">{hint}</p>}
      {error && <p role="alert" className="text-xs font-medium text-red-700">{error}</p>}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(fieldCls, className)} />;
}
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} className={cx(fieldCls, 'pr-8', className)}>{children}</select>;
}
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(fieldCls, className)} />;
}

/* ------------------------------------------------------------------ surfaces */

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-xl border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue';
const BADGE: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-800 ring-slate-300',
  green: 'bg-green-50 text-green-900 ring-green-300',
  amber: 'bg-amber-50 text-amber-900 ring-amber-300',
  red: 'bg-red-50 text-red-900 ring-red-300',
  blue: 'bg-blue-50 text-blue-900 ring-blue-300',
};
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset', BADGE[tone])}>{children}</span>;
}

export function StatCard({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: Tone }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">{label}</p>
      <p className={cx('mt-1 text-3xl font-bold tabular-nums', tone === 'red' ? 'text-red-800' : tone === 'amber' ? 'text-amber-800' : tone === 'green' ? 'text-green-800' : 'text-slate-900')}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-600">{hint}</p>}
    </div>
  );
}

const ALERT: Record<'success' | 'info' | 'warning' | 'error', { cls: string; icon: ReactNode }> = {
  success: { cls: 'border-green-300 bg-green-50 text-green-950', icon: <CheckCircle2 className="h-5 w-5 text-green-700" aria-hidden /> },
  info: { cls: 'border-blue-300 bg-blue-50 text-blue-950', icon: <Info className="h-5 w-5 text-blue-700" aria-hidden /> },
  warning: { cls: 'border-amber-300 bg-amber-50 text-amber-950', icon: <AlertTriangle className="h-5 w-5 text-amber-700" aria-hidden /> },
  error: { cls: 'border-red-300 bg-red-50 text-red-950', icon: <XCircle className="h-5 w-5 text-red-700" aria-hidden /> },
};
export function Alert({ tone = 'info', title, children, className }: { tone?: keyof typeof ALERT; title?: string; children?: ReactNode; className?: string }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('flex gap-3 rounded-lg border p-3 text-sm', ALERT[tone].cls, className)}>
      <span className="mt-0.5 shrink-0">{ALERT[tone].icon}</span>
      <div>{title && <p className="font-semibold">{title}</p>}{children && <div className={title ? 'mt-0.5' : ''}>{children}</div>}</div>
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span role="status" className="inline-flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{label}…</span>;
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden className="space-y-2">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="h-9 animate-pulse rounded-md bg-slate-100" />)}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center">
      <p className="font-semibold text-slate-800">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-md text-sm text-slate-600">{children}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ tables */

export interface Column<T> { key: string; header: string; cell: (row: T) => ReactNode; className?: string }

export function DataTable<T>({ columns, rows, rowKey, empty, loading, caption }:
  { columns: Column<T>[]; rows: T[] | undefined; rowKey: (r: T) => string; empty?: ReactNode; loading?: boolean; caption?: string }) {
  if (!rows && loading) return <Skeleton />;
  if (!rows || rows.length === 0) return <>{empty ?? <EmptyState title="Nothing to show" />}</>;
  return (
    <div className={cx('overflow-x-auto rounded-lg border border-slate-200', loading && 'opacity-60 transition-opacity')}>
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="bg-slate-50">
          <tr>{columns.map((c) => <th key={c.key} scope="col" className={cx('px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-700', c.className)}>{c.header}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {rows.map((r) => (
            <tr key={rowKey(r)} className="hover:bg-slate-50">
              {columns.map((c) => <td key={c.key} className={cx('px-3 py-2 align-top text-slate-900', c.className)}>{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ total, offset, limit, onChange }: { total: number; offset: number; limit: number; onChange: (offset: number) => void }) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <nav aria-label="Pagination" className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-700">
      <p>Showing <span className="font-semibold">{from}–{to}</span> of <span className="font-semibold">{total}</span></p>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))} aria-label="Previous page"><ChevronLeft className="h-4 w-4" aria-hidden />Prev</Button>
        <Button variant="secondary" size="sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)} aria-label="Next page">Next<ChevronRight className="h-4 w-4" aria-hidden /></Button>
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------ dialogs */

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,textarea,select,button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} className={cx('max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white shadow-xl sm:rounded-2xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 id={id} className="text-lg font-semibold text-slate-900">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close dialog" className="rounded-md p-1 text-slate-600 hover:bg-slate-100"><X className="h-5 w-5" aria-hidden /></button>
        </header>
        <div className="space-y-4 px-5 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/** Confirmation dialog for sensitive operations. `requireReason` forces a written reason (min 3 characters) like the database does. */
export function ConfirmDialog({ title, children, confirmLabel = 'Confirm', tone = 'primary', requireReason, reasonLabel = 'Reason', onConfirm, onClose, extra, confirmDisabled }:
  { title: string; children?: ReactNode; confirmLabel?: string; tone?: 'primary' | 'danger'; requireReason?: boolean; reasonLabel?: string;
    onConfirm: (reason: string) => Promise<void>; onClose: () => void; extra?: ReactNode; confirmDisabled?: boolean }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = confirmDisabled || (requireReason && reason.trim().length < 3);
  const submit = async () => {
    setBusy(true); setError(null);
    try { await onConfirm(reason.trim()); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong'); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={busy ? () => undefined : onClose}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant={tone} onClick={submit} loading={busy} disabled={invalid}>{confirmLabel}</Button>
      </>}>
      {children && <div className="text-sm text-slate-800">{children}</div>}
      {extra}
      {requireReason && (
        <Field label={reasonLabel} hint="Required. Recorded in the audit log." htmlFor="reason">
          <Textarea id="reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
      )}
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}

/* ------------------------------------------------------------------ toasts */

interface Toast { id: number; tone: 'success' | 'error' | 'info'; text: string }
const ToastCtx = createContext<{ push: (tone: Toast['tone'], text: string) => void }>({ push: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = next.current++;
    setItems((s) => [...s, { id, tone, text }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), tone === 'error' ? 8000 : 4500);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:items-end sm:pr-6">
        {items.map((t) => (
          <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'}
            className={cx('pointer-events-auto flex max-w-md items-start gap-2 rounded-lg px-4 py-3 text-sm font-medium shadow-lg',
              t.tone === 'error' ? 'bg-red-800 text-white' : t.tone === 'success' ? 'bg-green-800 text-white' : 'bg-slate-800 text-white')}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function Tabs({ tabs, value, onChange }: { tabs: Array<{ key: string; label: string }>; value: string; onChange: (k: string) => void }) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
      {tabs.map((t) => (
        <button key={t.key} role="tab" type="button" aria-selected={value === t.key} onClick={() => onChange(t.key)}
          className={cx('whitespace-nowrap border-b-2 px-4 py-2 text-sm font-semibold', value === t.key ? 'border-blue-700 text-blue-900' : 'border-transparent text-slate-600 hover:text-slate-900')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
