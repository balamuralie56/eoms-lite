const PREFIX = 'eoms_tour_seen:';

/** localStorage only — per-browser, not per-admin-account. Falls back to "seen" on any storage error so a blocked store never forces a tour. */
export function hasSeenTour(key: string): boolean {
  try { return localStorage.getItem(PREFIX + key) === '1'; } catch { return true; }
}

export function markTourSeen(key: string): void {
  try { localStorage.setItem(PREFIX + key, '1'); } catch { /* ignore */ }
}

export function resetAllTours(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
}
