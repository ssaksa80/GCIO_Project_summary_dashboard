/**
 * Project hierarchy ("chain") resolution: ancestors up the parentId links,
 * descendants as a depth-limited tree (SPEC §4). Cycle-safe throughout.
 */

const MAX_DEPTH = 6;

/** Compact node used inside chain payloads. */
function mini(project) {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    health: project.health,
    percentComplete: project.percentComplete,
  };
}

/**
 * Resolve a project's chain.
 * @param {import('./store.js').Store} store
 * @param {string} id
 * @returns {{ancestors: object[], children: object[]}} ancestors root-first;
 *          children as recursive {..mini, children:[]} trees.
 */
export function getChain(store, id) {
  const project = store.get(id);
  if (!project) return { ancestors: [], children: [] };

  const ancestors = [];
  const visited = new Set([project.id]);
  let cursor = project.parentId ? store.get(project.parentId) : null;
  while (cursor && !visited.has(cursor.id) && ancestors.length < MAX_DEPTH) {
    visited.add(cursor.id);
    ancestors.unshift(mini(cursor));
    cursor = cursor.parentId ? store.get(cursor.parentId) : null;
  }

  const childrenIndex = new Map();
  for (const p of store.all()) {
    if (!p.parentId) continue;
    if (!childrenIndex.has(p.parentId)) childrenIndex.set(p.parentId, []);
    childrenIndex.get(p.parentId).push(p);
  }

  const buildTree = (parentId, depth, seen) => {
    if (depth >= MAX_DEPTH) return [];
    const kids = childrenIndex.get(parentId) || [];
    return kids
      .filter((k) => !seen.has(k.id))
      .sort((a, b) => b.budget - a.budget)
      .map((k) => {
        seen.add(k.id);
        return { ...mini(k), children: buildTree(k.id, depth + 1, seen) };
      });
  };

  return { ancestors, children: buildTree(project.id, 0, new Set([project.id])) };
}
