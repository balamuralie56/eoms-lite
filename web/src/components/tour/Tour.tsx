import { useEffect, useLayoutEffect, useState } from 'react';
import { X } from 'lucide-react';

export interface TourStep { selector: string; title: string; body: string }

function useTargetRect(selector: string | null) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    const update = () => {
      const el = selector ? document.querySelector(selector) : null;
      setRect(el ? el.getBoundingClientRect() : null);
    };
    const raf = requestAnimationFrame(() => {
      if (selector) document.querySelector(selector)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      update();
    });
    const settle = setTimeout(update, 300);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      cancelAnimationFrame(raf); clearTimeout(settle);
      window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true);
    };
  }, [selector]);
  return rect;
}

/**
 * Minimal spotlight tour: no dependency, positions itself off the real DOM element for each step.
 * A step whose selector isn't currently on the page is skipped automatically (e.g. an empty table's row actions).
 */
export function Tour({ steps, onDone, onSkip }: { steps: TourStep[]; onDone: () => void; onSkip: () => void }) {
  const [i, setI] = useState(0);

  const step = steps[i] as TourStep | undefined;
  const selector = step?.selector ?? null;
  const rect = useTargetRect(selector);

  // A step whose element isn't currently on the page (e.g. an empty table's row actions) is skipped automatically.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (!step) { onDone(); return; }
      if (selector && !document.querySelector(selector)) {
        if (i + 1 < steps.length) setI(i + 1); else onDone();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [i, step, selector, steps.length, onDone]);

  if (!step || !rect) return null;

  const next = () => { if (i + 1 < steps.length) setI(i + 1); else onDone(); };
  const back = () => setI((x) => Math.max(0, x - 1));

  const pad = 6;
  const top = rect.top - pad, left = rect.left - pad, w = rect.width + pad * 2, h = rect.height + pad * 2;
  const popWidth = 320;
  const popBelow = top + h + 12 + 170 < window.innerHeight;
  const popTop = popBelow ? top + h + 12 : Math.max(12, top - 12 - 170);
  const popLeft = Math.min(Math.max(12, left), window.innerWidth - popWidth - 12);

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label="Guided tour">
      <button type="button" aria-label="Skip guide" onClick={onSkip} className="absolute inset-0 cursor-default" />
      <div className="pointer-events-none absolute rounded-lg outline outline-3 outline-offset-2 outline-yellow-400 transition-all duration-300"
        style={{ top, left, width: w, height: h, boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.65)' }} />
      <div className="absolute w-80 max-w-[calc(100vw-1.5rem)] rounded-xl bg-white p-4 shadow-2xl" style={{ top: popTop, left: popLeft }}>
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-sm font-bold text-slate-900">{step.title}</h2>
          <button type="button" aria-label="Close guide" onClick={onSkip} className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <p className="mt-1.5 text-sm text-slate-700">{step.body}</p>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-slate-500">{i + 1} of {steps.length}</span>
          <div className="flex gap-2">
            {i > 0 && <button type="button" onClick={back} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-100">Back</button>}
            <button type="button" onClick={next} className="rounded-lg bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800">
              {i + 1 < steps.length ? 'Next' : 'Done'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
