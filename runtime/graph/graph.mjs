// An in-memory view of the projected graph for detectors and algorithms. Built either
// from the store (the normal path) or directly from facts (tests, fixtures, worktrees
// being compared against a baseline).

import { edgeId } from './facts.mjs';

export class Graph {
  constructor() {
    this.nodeMap = new Map();
    this.edgeMap = new Map();
    this.outIdx = new Map();
    this.inIdx = new Map();
    this.typeIdx = new Map();
  }

  /** Merge node/edge facts. Repeated observations of the same node merge their attrs. */
  static fromFacts(facts) {
    const g = new Graph();
    for (const f of facts) if (f.kind === 'node') g.addNode(f.id, f.type, f);
    for (const f of facts) if (f.kind === 'edge') g.addEdge(f.type, f.from, f.to, f.attrs, f.provenance);
    return g;
  }

  static fromStore(store) {
    const g = new Graph();
    for (const r of store.db.prepare('SELECT * FROM nodes ORDER BY id').iterate()) {
      g.nodeMap.set(r.id, { id: r.id, type: r.type, name: r.name, path: r.path, attrs: JSON.parse(r.attrs), label: r.label, fact_ids: JSON.parse(r.fact_ids) });
      g.index(g.typeIdx, r.type, r.id);
    }
    for (const r of store.db.prepare('SELECT * FROM edges ORDER BY id').iterate()) {
      const e = { id: r.id, type: r.type, from: r.src, to: r.dst, attrs: JSON.parse(r.attrs), label: r.label, fact_ids: JSON.parse(r.fact_ids) };
      g.edgeMap.set(r.id, e);
      g.index(g.outIdx, r.src, e);
      g.index(g.inIdx, r.dst, e);
    }
    return g;
  }

  index(map, key, value) {
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    list.push(value);
  }

  addNode(id, type, { name, path, attrs = {}, provenance, label = 'observed' } = {}) {
    const existing = this.nodeMap.get(id);
    if (existing) {
      Object.assign(existing.attrs, attrs);
      if (provenance) existing.provenance.push(provenance);
      return existing;
    }
    const n = { id, type, name: name ?? id, path: path ?? null, attrs: { ...attrs }, label, provenance: provenance ? [provenance] : [] };
    this.nodeMap.set(id, n);
    this.index(this.typeIdx, type, id);
    return n;
  }

  addEdge(type, from, to, attrs = {}, provenance) {
    const id = edgeId(type, from, to);
    const existing = this.edgeMap.get(id);
    if (existing) {
      existing.attrs.count = (existing.attrs.count ?? 1) + (attrs.count ?? 1);
      if (provenance) existing.provenance.push(provenance);
      return existing;
    }
    const e = { id, type, from, to, attrs: { ...attrs }, label: 'observed', provenance: provenance ? [provenance] : [] };
    this.edgeMap.set(id, e);
    this.index(this.outIdx, from, e);
    this.index(this.inIdx, to, e);
    return e;
  }

  node(id) {
    return this.nodeMap.get(id) ?? null;
  }

  nodes(type) {
    if (!type) return [...this.nodeMap.values()];
    return (this.typeIdx.get(type) ?? []).map((id) => this.nodeMap.get(id));
  }

  edges(type) {
    const all = [...this.edgeMap.values()];
    return type ? all.filter((e) => e.type === type) : all;
  }

  out(id, type) {
    const list = this.outIdx.get(id) ?? [];
    return type ? list.filter((e) => (Array.isArray(type) ? type.includes(e.type) : e.type === type)) : list;
  }

  in(id, type) {
    const list = this.inIdx.get(id) ?? [];
    return type ? list.filter((e) => (Array.isArray(type) ? type.includes(e.type) : e.type === type)) : list;
  }

  /** Children by CONTAINS (file → function, package → module). */
  children(id, type) {
    return this.out(id, 'CONTAINS').map((e) => this.node(e.to)).filter((n) => n && (!type || n.type === type));
  }

  parent(id) {
    const e = this.in(id, 'CONTAINS')[0];
    return e ? this.node(e.from) : null;
  }

  get size() {
    return { nodes: this.nodeMap.size, edges: this.edgeMap.size };
  }
}
