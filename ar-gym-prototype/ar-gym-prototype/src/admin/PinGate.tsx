/** Shared PIN screen for the admin panel and the results view. */
import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiFailure } from '../lib/api';
import { getToken, login } from './adminApi';

interface Props {
  title: string;
  children: (token: string, signOut: () => void) => ReactNode;
}

export function PinGate({ title, children }: Props) {
  const [token, setToken] = useState<string | null>(() => getToken());
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (token) return <>{children(token, () => setToken(null))}</>;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setToken(await login(pin));
      setPin('');
    } catch (failure) {
      setError(failure instanceof ApiFailure ? failure.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="admin admin-login">
      <form className="admin-card" onSubmit={(event) => void submit(event)}>
        <h1>{title}</h1>
        <label className="field">
          <span className="field-label">Team PIN</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            value={pin}
            maxLength={32}
            onChange={(event) => setPin(event.target.value)}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-wide" disabled={busy || !pin}>
          {busy ? 'Checking…' : 'Open'}
        </button>
      </form>
    </main>
  );
}
