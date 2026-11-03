import { getSupabase } from './supabase';

/** A database or transport error, normalised. status 0 = the request never reached the server. */
export class ApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = '', status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
  get isNetwork(): boolean { return this.status === 0; }
  get isUnauthorized(): boolean { return this.status === 401 || /jwt/i.test(this.message); }
  get isForbidden(): boolean { return this.status === 403 || this.code === '42501'; }
}

export async function callRpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error, status } = await getSupabase().rpc(name, args);
  if (error) throw new ApiError(error.message || 'Request failed', error.code || '', status || 0);
  return data as T;
}
