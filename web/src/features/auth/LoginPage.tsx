import { FormEvent, useState } from 'react';
import { ArrowRight, LockKeyhole } from 'lucide-react';
import { ApiError } from '../../app/api';
import { SessionStore } from '../../app/auth';

export default function LoginPage({ store }: { store: SessionStore }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await store.login(username, password);
    } catch (error) {
      setMessage(error instanceof ApiError && error.status === 429 ? 'Too many attempts. Try again in a moment.' : 'That username or password was not recognised.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-atmosphere" aria-label="77Photo private family library">
        <div className="atmosphere-top"><span className="brand-mark">77</span><span>77Photo</span></div>
        <div className="atmosphere-copy"><span className="eyebrow">Your family library</span><h1>Keep the moments<br /><em>close.</em></h1><p>A calm, private home for the photographs you want to remember.</p></div>
        <div className="memory-strips" aria-hidden="true"><span className="memory-strip strip-one" /><span className="memory-strip strip-two" /><span className="memory-strip strip-three" /></div>
        <span className="atmosphere-foot">Stored on your own server</span>
      </section>
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-panel-inner">
          <div className="mobile-brand"><span className="brand-mark">77</span><strong>77Photo</strong></div>
          <div className="login-heading"><span className="eyebrow">Welcome back</span><h2 id="login-title">Sign in to your library</h2><p>Your photos are waiting, exactly where you left them.</p></div>
          <form className="login-form" onSubmit={submit}>
            <label>Username<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus required /></label>
            <label>Password<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required /></label>
            {message && <p className="form-message" role="alert"><LockKeyhole size={16} />{message}</p>}
            <button className="button button-primary submit-button" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}<ArrowRight size={18} /></button>
          </form>
          <p className="login-note">Only people you invite can access this library.</p>
        </div>
      </section>
    </main>
  );
}
