/**
 * Authentication and authorisation failures.
 *
 * Mirrors DEDB's auth/errors.js: a typed error carrying the HTTP status and a
 * stable code, so routes can throw and one handler renders the envelope. The
 * message is what the user sees, so it must never disclose which half of a
 * credential was wrong.
 */
export class AuthError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code stable machine-readable code
   * @param {string} message safe to show the caller
   */
  constructor(status, code, message) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

export const badCredentials = () =>
  new AuthError(401, "bad_credentials", "sign-in failed: check the username and password");

export const noAccess = () =>
  new AuthError(403, "no_access", "your account is not a member of any group granted access to this dashboard");

export const directoryUnavailable = (detail) =>
  new AuthError(503, "directory_unavailable", `the directory could not be reached: ${detail}`);

/*
  The APP's own directory credential is wrong, not the user's.

  Deliberately NOT bad_credentials. Under search-then-bind the service account
  binds before the user does, so a wrong service password fails every sign-in in
  the organisation - and as a 401 that tells every one of those users to check a
  password that was never the problem. That is the same misdirection
  directoryUnavailable was added to stop, multiplied by the whole user base.

  Carries no credential detail: an unauthenticated caller must not learn what the
  app binds as, or whether a given service account exists.
*/
export const directoryMisconfigured = (detail) =>
  new AuthError(503, "directory_misconfigured",
    `the directory rejected this application's own credentials: ${detail}`);
