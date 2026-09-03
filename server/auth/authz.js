/**
 * Role resolution.
 *
 * Mirrors DEDB's auth/authz.js: a fixed precedence list, group memberships
 * folded to the highest role they grant, and no access at all when nothing
 * matches — membership of an unmapped group must never imply a default role.
 */
import { AuthError, noAccess } from "./errors.js";

/** Highest first. */
export const PRECEDENCE = ["admin", "pm", "viewer"];

/** Rank for comparisons elsewhere (higher number = more authority). */
export const RANK = { viewer: 1, pm: 2, admin: 3 };

/**
 * Highest-precedence role among those given, or null.
 * @param {...(string|null|undefined)} roles
 */
export function bestRole(...roles) {
  let best = null;
  let bestRank = PRECEDENCE.length;
  for (const role of roles) {
    const i = PRECEDENCE.indexOf(String(role || "").toLowerCase());
    if (i >= 0 && i < bestRank) {
      best = PRECEDENCE[i];
      bestRank = i;
    }
  }
  return best;
}

/**
 * Fold directory groups to the highest app role they grant.
 * @param {string[]} groups group names from the directory
 * @param {Record<string, string>} roleMap lower-cased group name -> role
 */
export function resolveRole(groups, roleMap) {
  let best = null;
  let bestRank = PRECEDENCE.length;
  for (const group of groups || []) {
    const role = roleMap?.[String(group).toLowerCase()];
    if (!role) continue;
    const rank = PRECEDENCE.indexOf(String(role).toLowerCase());
    if (rank >= 0 && rank < bestRank) {
      best = PRECEDENCE[rank];
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Resolve what a signed-in principal may do. Throws 403 when the directory
 * says who they are but nothing grants them access.
 *
 * @param {{principal: string, groups: string[]}} identity
 * @param {{roleMapping: {getMap: Function}}} deps
 * @returns {Promise<{role: string}>}
 */
export async function resolveAccess({ principal, groups }, deps) {
  if (!principal) throw new AuthError(401, "no_principal", "sign-in failed");
  const roleMap = await deps.roleMapping.getMap();
  const groupRole = resolveRole(groups, roleMap);

  /* Per-user grants are the second source, so an admin can give one person a
     role without asking the directory team for a group. Optional: callers that
     predate it (and most tests) pass only roleMapping, and this must keep
     working for them rather than becoming mandatory everywhere at once. */
  const userMap = deps.userRoleMapping ? await deps.userRoleMapping.getMap() : {};
  const userRole = userMap[String(principal).toLowerCase()];

  /* Highest of the two wins. A stale low grant must not demote someone their
     group has promoted - revoking is done by removing the grant, not by
     lowering it. */
  const role = bestRole(groupRole, userRole);

  /* Authenticating is not authorisation. Membership of an unmapped group must
     never imply a default role, so someone the directory knows but nothing
     grants gets 403 rather than a quiet read-only session. */
  if (!role) throw noAccess();
  return { role };
}
