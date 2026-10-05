// Repository conventions that several detectors share.

const libraryDirsCache = new WeakMap();

/**
 * Directories of component code a generator wrote into the repository on purpose (shadcn/ui,
 * declared by `components.json`): the full set is kept even when some components are unused,
 * and the copies share wrapper boilerplate by design. Dead-code, oversized-API and clone
 * findings there were noise on an unfamiliar repository.
 */
export function libraryDirs(graph) {
  if (!libraryDirsCache.has(graph)) {
    const dirs = [];
    for (const f of graph.nodes('file')) if (typeof f.attrs?.component_library === 'string') dirs.push(f.attrs.component_library);
    libraryDirsCache.set(graph, dirs);
  }
  return libraryDirsCache.get(graph);
}

export const inLibraryDir = (graph, path) => typeof path === 'string' && libraryDirs(graph).some((d) => path.startsWith(`${d}/`));
