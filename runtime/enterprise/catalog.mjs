// Service catalog reconciliation (spec §30 Phase 7). The catalog (Backstage-derived
// `service:` nodes) says what the organization believes exists; the mapped deployables
// and workloads say what the code and infrastructure actually define. The gaps between
// the two are the useful output: catalog entries pointing at nothing, services nobody
// owns, and teams that own no service.

const clean = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
const under = (path, root) => root === '' || root === '.' || path === root || path.startsWith(`${root}/`);

/** Every path-ish attribute a deployable or workload might carry, normalised. */
function candidatePaths(n) {
  const a = n.attrs ?? {};
  return [n.path, a.path, a.dir, a.manifest, a.declared_in, a.context, a.source]
    .filter((v) => typeof v === 'string' && v)
    .map(clean);
}

/** The last segment of a node's name, so `prod/Deployment/orders` matches service `orders`. */
const shortName = (n) => String(n.name ?? '').split('/').pop().toLowerCase();

/**
 * @param {import('../graph/graph.mjs').Graph} graph a single-repository or workspace graph
 * @returns {{services: object[], unmapped_code_roots: object[], services_without_owner: string[], owners_without_services: string[]}}
 */
export function catalogSummary(graph) {
  const runnable = [...graph.nodes('deployable'), ...graph.nodes('workload')];
  const modules = [...graph.nodes('module'), ...graph.nodes('package')];
  const services = [];
  const unmapped = [];
  const withoutOwner = [];
  const ownedTeams = new Set();

  for (const s of graph.nodes('service').sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const repo = s.attrs?.repo ?? null;
    const root = typeof s.attrs?.code_root === 'string' ? clean(s.attrs.code_root) : null;
    const sameRepo = (n) => !repo || !n.attrs?.repo || n.attrs.repo === repo;
    const name = String(s.name ?? s.id).toLowerCase();
    const matched = runnable.filter(
      (n) => sameRepo(n) && (shortName(n) === name || (root !== null && candidatePaths(n).some((p) => under(p, root)))),
    );
    const codePresent = root !== null && modules.some((n) => sameRepo(n) && typeof n.path === 'string' && under(clean(n.path), root));
    const ownerEdge = graph.out(s.id, 'OWNED_BY')[0];
    const owner = s.attrs?.owner ?? (ownerEdge ? graph.node(ownerEdge.to)?.name : null) ?? null;
    if (!owner) withoutOwner.push(s.name ?? s.id);
    if (owner) ownedTeams.add(String(owner));
    services.push({
      id: s.id,
      name: s.name ?? s.id,
      repo,
      owner,
      code_root: root,
      tier: s.attrs?.tier ?? null,
      lifecycle: s.attrs?.lifecycle ?? null,
      deployables: matched.map((n) => n.id).sort(),
      code_present: codePresent,
      mapped: matched.length > 0,
    });
    if (root !== null && matched.length === 0) unmapped.push({ service: s.name ?? s.id, repo, code_root: root, code_present: codePresent });
  }

  const owners = graph.nodes('team').filter((t) => !ownedTeams.has(String(t.name ?? t.id))).map((t) => t.name ?? t.id);
  return {
    services,
    unmapped_code_roots: unmapped,
    services_without_owner: withoutOwner.sort(),
    owners_without_services: [...new Set(owners)].sort(),
  };
}
