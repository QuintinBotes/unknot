// Agent handoffs (spec §7.1). A specialist agent ends its work with one JSON handoff;
// the runtime validates it against the schema and records it. Prose around it is
// ignored: free-form text cannot authorize execution.

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { digest } from '../core/canonical.mjs';
import { redactDeep } from '../core/redact.mjs';
import { validateArtifact } from '../core/schema.mjs';
import { modeRank } from '../policy/defaults.mjs';
import { casPut } from './cas.mjs';
import { appendEvent } from './ledger.mjs';

/** The last fenced JSON block (or bare JSON object) that looks like a handoff. */
export function extractHandoff(text) {
  if (typeof text !== 'string') return null;
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) blocks.push(trimmed);
  for (const b of blocks.reverse()) {
    try {
      const obj = JSON.parse(b);
      if (obj && typeof obj === 'object' && 'schema_version' in obj && 'agent' in obj) return obj;
    } catch {
      // not JSON; keep looking
    }
  }
  return null;
}

/** Last assistant text in a Claude Code transcript (JSONL), reading only the tail. */
export function lastAssistantText(transcriptPath, maxBytes = 2 * 1024 * 1024) {
  let fd;
  try {
    const size = statSync(transcriptPath).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fd = openSync(transcriptPath, 'r');
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const msg = entry.message ?? entry;
        if ((entry.type === 'assistant' || msg.role === 'assistant') && msg.content) {
          const content = Array.isArray(msg.content) ? msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : String(msg.content);
          if (content.trim()) return content;
        }
      } catch {
        // partial first line of the window
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

/**
 * Validate a handoff. Outside governed mode, unknown fields are stripped with a warning;
 * in governed (or campaign) mode they are rejected (spec §7.1).
 */
export function validateHandoff(obj, mode) {
  let res = validateArtifact('handoff', obj);
  if (res.valid) return { ok: true, handoff: obj, warnings: [] };
  const onlyUnknown = res.errors.every((e) => e.keyword === 'additionalProperties');
  if (!onlyUnknown || modeRank(mode) >= modeRank('governed')) return { ok: false, errors: res.errors };
  const cleaned = stripUnknown(obj);
  res = validateArtifact('handoff', cleaned);
  return res.valid ? { ok: true, handoff: cleaned, warnings: ['unknown handoff fields were dropped'] } : { ok: false, errors: res.errors };
}

const TOP = ['schema_version', 'run_id', 'slice_id', 'agent', 'status', 'facts', 'proposals', 'uncertainties', 'conflicts', 'artifacts', 'recommended_next_state'];
function stripUnknown(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => TOP.includes(k)));
}

export function recordHandoff(ctx, { run, handoff, agentId, warnings = [] }) {
  const safe = redactDeep(handoff);
  const ref = casPut(ctx, JSON.stringify(safe), { mediaType: 'application/json', runId: run?.id, label: `handoff.${handoff.agent}` });
  appendEvent(ctx, {
    type: 'handoff.received',
    run_id: run?.id,
    slice_id: handoff.slice_id ?? run?.slice_id ?? null,
    actor: `model:${handoff.agent}`,
    payload: {
      agent_id: agentId,
      status: handoff.status,
      ref,
      digest: digest(safe),
      counts: { facts: handoff.facts.length, proposals: handoff.proposals.length, uncertainties: handoff.uncertainties.length, conflicts: handoff.conflicts.length },
      recommended_next_state: handoff.recommended_next_state,
      warnings,
    },
  });
  return ref;
}
