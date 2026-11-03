import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export class ConfigError extends Error {}

let client: SupabaseClient | null = null;

/** Lazily created so missing configuration shows a friendly screen instead of crashing at import time. */
export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !key) {
    throw new ConfigError('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are not set.');
  }
  client = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return client;
}

export function isConfigured(): boolean {
  return Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
}

/** Test seam: inject a fake client. */
export function setSupabaseForTests(c: SupabaseClient | null): void {
  client = c;
}
