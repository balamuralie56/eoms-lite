import { useCallback, useState } from 'react';
import { hasSeenTour, markTourSeen } from '../../lib/tourStore';
import type { TourStep } from './Tour';

/** Runs the tour once automatically per browser (tracked in localStorage); `replay()` restarts it on demand. */
export function useAutoTour(pageKey: string, steps: TourStep[]) {
  const [running, setRunning] = useState(() => !hasSeenTour(pageKey));
  const finish = useCallback(() => { markTourSeen(pageKey); setRunning(false); }, [pageKey]);
  const replay = useCallback(() => setRunning(true), []);
  return { running, steps, finish, replay };
}
