/** Admin-side helpers: token storage and authenticated calls. */
import { ApiFailure, api } from '../lib/api';
import { KEYS, loadJson, removeKey, saveJson } from '../lib/storage';

interface StoredToken {
  token: string;
  expires_at: string;
}

export function getToken(): string | null {
  const stored = loadJson<StoredToken>(KEYS.adminToken);
  if (!stored || new Date(stored.expires_at).getTime() <= Date.now()) return null;
  return stored.token;
}

export async function login(pin: string): Promise<string> {
  const data = await api.post<StoredToken>('/api/admin/login', { pin });
  saveJson(KEYS.adminToken, data);
  return data.token;
}

export function logout(): void {
  removeKey(KEYS.adminToken);
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiFailure && error.status === 401;
}

/** Download a CSV with the token in a header (so it never appears in a URL or history). */
export async function downloadCsv(kind: 'sessions' | 'events' | 'responses', token: string): Promise<void> {
  const response = await fetch(`/api/admin/results?format=csv&kind=${kind}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new ApiFailure('Export failed. Try again.', response.status, 'export_failed');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `ar-gym-${kind}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
