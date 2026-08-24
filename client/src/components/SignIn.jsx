/**
 * Sign-in screen.
 *
 * Shown instead of the dashboard when there is no session. The server decides
 * everything that matters — this only collects a credential and reports what
 * came back, without guessing which half was wrong.
 */
import { useState } from "react";
import { postJSON } from "../lib/api.js";

export default function SignIn({ onSignedIn, devMode }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

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
    <div className="signin-wrap">
      <form className="card signin" onSubmit={submit}>
        <span className="brand-sub">GCIO · Project Intelligence</span>
        <h1 className="display signin-title">Sign in</h1>
        <p className="meta">
          Use your normal network account. Access is granted by directory group
          membership; if you have none, ask the CIO office to add you.
        </p>

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
    </div>
  );
}
