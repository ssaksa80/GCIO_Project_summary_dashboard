/**
 * Entra sign-in from the browser.
 *
 * MSAL acquires an ID token; the server validates it and decides everything.
 * Nothing here makes an authorisation decision — the role comes back from
 * /api/auth/sso, resolved server-side from directory groups.
 *
 * The library is imported dynamically, so a deployment with SSO switched off
 * never downloads it. It is around 200 kB, which is a lot to ship to people
 * who sign in with a password.
 */
import { postJSON } from "./api.js";

let appPromise = null;

/**
 * @param {{clientId: string, tenantId: string}} cfg from /api/me
 */
async function client(cfg) {
  if (!appPromise) {
    appPromise = (async () => {
      const { PublicClientApplication } = await import("@azure/msal-browser");
      const app = new PublicClientApplication({
        auth: {
          clientId: cfg.clientId,
          authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
          redirectUri: window.location.origin,
        },
        /* sessionStorage, not localStorage: the token cache should not outlive
           the browser session on a shared workstation. */
        cache: { cacheLocation: "sessionStorage", storeAuthStateInCookie: false },
      });
      await app.initialize();
      return app;
    })().catch((err) => {
      appPromise = null; // a failed load must not poison every later attempt
      throw err;
    });
  }
  return appPromise;
}

/**
 * Pop up the Microsoft sign-in, then exchange the ID token for a session.
 *
 * @param {{clientId: string, tenantId: string}} cfg
 * @returns {Promise<{authenticated: boolean, principal: string, displayName: string, role: string}>}
 */
export async function signInWithSso(cfg) {
  if (!cfg?.clientId || !cfg?.tenantId) {
    throw new Error("single sign-on is not configured on this server");
  }
  const msal = await client(cfg);

  /* The nonce is echoed in the token and checked server-side, so a token
     captured from another sign-in cannot be replayed here. */
  const nonce = crypto.randomUUID();
  const result = await msal.loginPopup({
    scopes: ["openid", "profile", "email"],
    nonce,
    prompt: "select_account",
  });

  return postJSON("/api/auth/sso", { idToken: result.idToken, nonce });
}

/** Human-readable reasons for the failures MSAL raises before we reach the server. */
export function describeSsoError(err) {
  const code = err?.errorCode || "";
  if (code === "user_cancelled") return "sign-in was cancelled";
  if (code === "popup_window_error" || code === "empty_window_error") {
    return "the sign-in window was blocked — allow pop-ups for this site and try again";
  }
  if (code === "interaction_in_progress") return "a sign-in is already in progress";
  return err?.message || "single sign-on failed";
}
