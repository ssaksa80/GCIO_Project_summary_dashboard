/**
 * Sign-in screen.
 *
 * Shown instead of the dashboard when there is no session. The server decides
 * everything that matters — this only collects a credential and reports what
 * came back, without guessing which half was wrong.
 */
import { useState } from "react";
import { postJSON } from "../lib/api.js";
import { signInWithSso, describeSsoError } from "../lib/sso.js";

export default function SignIn({ onSignedIn, devMode, sso, entra }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const startSso = async () => {
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await signInWithSso(entra));
    } catch (err) {
      setError(describeSsoError(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await postJSON("/api/auth/login", { username, password });
      onSignedIn(me);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    /* <main>, not a <div>: the sign-in screen is a page in its own right and
       had no landmark at all, so every one of its elements - the brand line,
       the heading, the explanatory paragraph - was reported as content outside
       any landmark (Findings 3 and 4). The class is unchanged, so the layout
       is too. */
    <main className="signin-wrap">
      <form className="card signin" onSubmit={submit}>
        <span className="brand-sub">GCIO · Project Intelligence</span>
        <h1 className="display signin-title">Sign in</h1>
        <p className="meta">
          Use your normal network account. Access is granted by directory group
          membership; if you have none, ask the CIO office to add you.
        </p>

        {sso && entra && (
          <>
            <button type="button" className="btn signin-submit signin-sso" onClick={startSso} disabled={busy}>
              <svg width="15" height="15" viewBox="0 0 23 23" aria-hidden="true">
                <rect x="1" y="1" width="10" height="10" fill="#f25022" />
                <rect x="12" y="1" width="10" height="10" fill="#7fba00" />
                <rect x="1" y="12" width="10" height="10" fill="#00a4ef" />
                <rect x="12" y="12" width="10" height="10" fill="#ffb900" />
              </svg>
              Sign in with Microsoft
            </button>
            <div className="signin-or"><span>or use your network account</span></div>
          </>
        )}

        <label className="field">
          <span className="lab">Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>

        <label className="field">
          <span className="lab">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error && <p className="signin-error">{error}</p>}

        <button type="submit" className="btn primary signin-submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        {devMode && (
          <p className="micro signin-dev">
            Development mode: any password is accepted and the role comes from DEV_ROLE.
          </p>
        )}
      </form>
    </main>
  );
}
