import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as K from '../../helpers/kernel.mjs';

const { appendEvent, verifyLedger, readEvents, GENESIS } = K.ledger;

after(() => K.cleanup());

function seeded(n = 6) {
  const p = K.makeProject();
  const pub = p.ctx.store.meta('audit_public_key');
  for (let i = 0; i < n; i++) {
    appendEvent(p.ctx, {
      type: 'test.event',
      actor: 'human:t',
      run_id: 'run-1',
      slice_id: 'UK-0001',
      scope: { i },
      budget: { max_tool_calls: i },
      policy_decision: { decision: 'allow' },
      payload: { i, nested: { z: 1, a: 2 } },
    });
  }
  return { p, pub };
}

function dropTriggers(store) {
  store.db.exec('DROP TRIGGER events_append_only_u; DROP TRIGGER events_append_only_d;');
}

describe('ledger chain', () => {
  test('a fresh chain verifies with and without the public key', () => {
    const { p, pub } = seeded();
    const plain = verifyLedger(p.ctx.store);
    assert.equal(plain.ok, true);
    assert.equal(plain.count, 6);
    const signed = verifyLedger(p.ctx.store, pub);
    assert.equal(signed.ok, true);
    assert.equal(signed.head, plain.head);
  });

  test('first event links to genesis and each prev_hash is the prior hash', () => {
    const { p } = seeded(3);
    const evs = readEvents(p.ctx.store);
    assert.equal(evs[0].prev_hash, GENESIS);
    assert.equal(evs[1].prev_hash, evs[0].hash);
    assert.equal(evs[2].prev_hash, evs[1].hash);
    assert.ok(evs.every((e) => e.signature && e.hash.startsWith('sha256:')));
  });

  test('empty ledger verifies', () => {
    const p = K.makeProject();
    assert.deepEqual(verifyLedger(p.ctx.store, p.ctx.store.meta('audit_public_key')), { ok: true, count: 0, head: GENESIS });
  });

  test('bad event type and actor are rejected before anything is written', () => {
    const p = K.makeProject();
    for (const type of ['', 'Bad', 'nodot', 'a.B', undefined, 'a..b', 'a.b-c']) {
      assert.throws(() => appendEvent(p.ctx, { type, actor: 'human:t' }), (e) => e.code === 'UK_SCHEMA_INVALID', String(type));
    }
    for (const actor of ['', 'root', 'model', 'bot:x', 'human:', 'human:a b', undefined]) {
      assert.throws(() => appendEvent(p.ctx, { type: 'a.b', actor }), (e) => e.code === 'UK_SCHEMA_INVALID', String(actor));
    }
    assert.equal(p.ctx.store.get('SELECT COUNT(*) AS n FROM events').n, 0);
  });

  test('readEvents filters by run, slice, type and afterSeq', () => {
    const p = K.makeProject();
    appendEvent(p.ctx, { type: 'a.one', actor: 'human:t', run_id: 'r1' });
    appendEvent(p.ctx, { type: 'a.two', actor: 'human:t', run_id: 'r2', slice_id: 'UK-0002' });
    appendEvent(p.ctx, { type: 'a.one', actor: 'human:t', run_id: 'r2' });
    assert.equal(readEvents(p.ctx.store, { runId: 'r2' }).length, 2);
    assert.equal(readEvents(p.ctx.store, { sliceId: 'UK-0002' }).length, 1);
    assert.equal(readEvents(p.ctx.store, { type: 'a.one' }).length, 2);
    assert.equal(readEvents(p.ctx.store, { afterSeq: 2 }).length, 1);
  });
});

describe('append-only triggers', () => {
  test('UPDATE of any column is blocked', () => {
    const { p } = seeded(2);
    for (const col of ['type', 'actor', 'payload', 'hash', 'prev_hash', 'signature', 'at', 'run_id']) {
      assert.throws(() => p.ctx.store.run(`UPDATE events SET ${col} = 'x' WHERE seq = 1`), /append-only/, col);
    }
    assert.equal(verifyLedger(p.ctx.store).ok, true);
  });

  test('DELETE is blocked, singly and in bulk', () => {
    const { p } = seeded(2);
    assert.throws(() => p.ctx.store.run('DELETE FROM events WHERE seq = 1'), /append-only/);
    assert.throws(() => p.ctx.store.run('DELETE FROM events'), /append-only/);
    assert.equal(p.ctx.store.get('SELECT COUNT(*) AS n FROM events').n, 2);
  });

  test('INSERT OR REPLACE cannot overwrite an existing seq', {}, () => {
    const { p } = seeded(2);
    const row = p.ctx.store.get('SELECT * FROM events WHERE seq = 1');
    assert.throws(() => p.ctx.store.run(
      'INSERT OR REPLACE INTO events (seq,id,schema_version,type,actor,payload,at,prev_hash,hash) VALUES (?,?,?,?,?,?,?,?,?)',
      1, 'ev-x', '1.0', 'a.b', 'human:t', '{}', row.at, row.prev_hash, row.hash,
    ));
    assert.equal(verifyLedger(p.ctx.store).ok, true);
  });
});

describe('tamper detection (triggers dropped)', () => {
  const TEXT_COLS = [
    ['type', 'a.other'],
    ['actor', 'human:evil'],
    ['run_id', 'run-9'],
    ['slice_id', 'UK-9999'],
    ['at', '2001-01-01T00:00:00.000Z'],
    ['schema_version', '9.9'],
    ['id', 'ev-forged'],
    ['capability_id', 'cap-forged'],
    ['campaign_id', 'C-1'],
    ['payload', '{"i":999}'],
    ['scope', '{"i":999}'],
    ['budget', '{"max_tool_calls":999}'],
    ['policy_decision', '{"decision":"deny"}'],
  ];
  for (const [col, val] of TEXT_COLS) {
    test(`editing ${col} of seq 3 breaks the chain exactly at 3`, () => {
      const { p, pub } = seeded();
      dropTriggers(p.ctx.store);
      p.ctx.store.run(`UPDATE events SET ${col} = ? WHERE seq = 3`, val);
      const r = verifyLedger(p.ctx.store, pub);
      assert.equal(r.ok, false);
      assert.equal(r.broken_at, 3);
      assert.equal(r.count, 2);
      assert.match(r.reason, /hash does not match/);
    });
  }

  test('editing hash of seq 4 breaks at 4 (hash mismatch)', () => {
    const { p, pub } = seeded();
    dropTriggers(p.ctx.store);
    p.ctx.store.run("UPDATE events SET hash = 'sha256:00' WHERE seq = 4");
    const r = verifyLedger(p.ctx.store, pub);
    assert.equal(r.broken_at, 4);
  });

  test('editing prev_hash of seq 2 breaks at 2 (link)', () => {
    const { p, pub } = seeded();
    dropTriggers(p.ctx.store);
    p.ctx.store.run("UPDATE events SET prev_hash = 'sha256:bad' WHERE seq = 2");
    const r = verifyLedger(p.ctx.store, pub);
    assert.equal(r.broken_at, 2);
    assert.match(r.reason, /link/);
  });

  test('deleting a middle row breaks at the row after it', () => {
    const { p, pub } = seeded();
    dropTriggers(p.ctx.store);
    p.ctx.store.run('DELETE FROM events WHERE seq = 3');
    const r = verifyLedger(p.ctx.store, pub);
    assert.equal(r.ok, false);
    assert.equal(r.broken_at, 4);
  });

  test('deleting the first row breaks at the new first row', () => {
    const { p } = seeded();
    dropTriggers(p.ctx.store);
    p.ctx.store.run('DELETE FROM events WHERE seq = 1');
    assert.equal(verifyLedger(p.ctx.store).broken_at, 2);
  });

  test('swapping the payloads of two events is detected', () => {
    const { p } = seeded();
    dropTriggers(p.ctx.store);
    const a = p.ctx.store.get('SELECT payload FROM events WHERE seq = 2').payload;
    const b = p.ctx.store.get('SELECT payload FROM events WHERE seq = 5').payload;
    p.ctx.store.run('UPDATE events SET payload = ? WHERE seq = 2', b);
    p.ctx.store.run('UPDATE events SET payload = ? WHERE seq = 5', a);
    assert.equal(verifyLedger(p.ctx.store).broken_at, 2);
  });

  test('a stripped signature passes the plain chain check but fails with the public key', () => {
    const { p, pub } = seeded();
    dropTriggers(p.ctx.store);
    p.ctx.store.run('UPDATE events SET signature = NULL WHERE seq = 5');
    assert.equal(verifyLedger(p.ctx.store).ok, true);
    const r = verifyLedger(p.ctx.store, pub);
    assert.equal(r.ok, false);
    assert.equal(r.broken_at, 5);
    assert.match(r.reason, /signature/);
  });

  test('a garbage signature fails with the public key', () => {
    const { p, pub } = seeded();
    dropTriggers(p.ctx.store);
    p.ctx.store.run("UPDATE events SET signature = 'AAAA' WHERE seq = 2");
    assert.equal(verifyLedger(p.ctx.store, pub).broken_at, 2);
  });

  test('a flipped signature byte fails', () => {
    const { p, pub } = seeded();
    dropTriggers(p.ctx.store);
    const sig = p.ctx.store.get('SELECT signature FROM events WHERE seq = 1').signature;
    const raw = Buffer.from(sig, 'base64');
    raw[0] ^= 0xff;
    p.ctx.store.run('UPDATE events SET signature = ? WHERE seq = 1', raw.toString('base64'));
    assert.equal(verifyLedger(p.ctx.store, pub).broken_at, 1);
  });

  test('wrong-key signature fails: an attacker who re-signs the chain with their own key is caught', () => {
    const { p, pub } = seeded();
    dropTriggers(p.ctx.store);
    const attacker = generateKeyPairSync('ed25519').privateKey;
    for (const row of p.ctx.store.all('SELECT seq, hash FROM events ORDER BY seq')) {
      p.ctx.store.run('UPDATE events SET signature = ? WHERE seq = ?', K.keys.signText(attacker, row.hash), row.seq);
    }
    assert.equal(verifyLedger(p.ctx.store).ok, true, 'chain alone cannot tell');
    const r = verifyLedger(p.ctx.store, pub);
    assert.equal(r.ok, false);
    assert.equal(r.broken_at, 1);
  });

  test('verifying against a different project\'s public key fails', () => {
    const { p } = seeded(2);
    const other = K.makeProject();
    assert.equal(verifyLedger(p.ctx.store, other.ctx.store.meta('audit_public_key')).ok, false);
  });

  test('a rewritten, internally consistent chain without the key is detected', () => {
    const { p, pub } = seeded(3);
    dropTriggers(p.ctx.store);
    // Forge: change payload of seq 2 and recompute hashes for 2 and 3, keeping old signatures.
    const rows = p.ctx.store.all('SELECT * FROM events ORDER BY seq');
    let prev = rows[0].hash;
    for (const row of rows.slice(1)) {
      const body = {
        schema_version: row.schema_version, id: row.id, type: row.type, run_id: row.run_id, campaign_id: row.campaign_id,
        slice_id: row.slice_id, actor: row.actor, capability_id: row.capability_id,
        scope: row.scope && JSON.parse(row.scope), budget: row.budget && JSON.parse(row.budget),
        policy_decision: row.policy_decision && JSON.parse(row.policy_decision),
        payload: row.seq === 2 ? { forged: true } : JSON.parse(row.payload), at: row.at, prev_hash: prev,
      };
      const hash = K.canonical.digest(body);
      p.ctx.store.run('UPDATE events SET payload = ?, prev_hash = ?, hash = ? WHERE seq = ?', K.canonical.canonicalJSON(body.payload), prev, hash, row.seq);
      prev = hash;
    }
    assert.equal(verifyLedger(p.ctx.store).ok, true, 'hash chain was rebuilt consistently');
    const r = verifyLedger(p.ctx.store, pub);
    assert.equal(r.ok, false);
    assert.equal(r.broken_at, 2);
  });
});

describe('ledger atomicity', () => {
  test('an append inside a rolled-back transaction leaves no event', () => {
    const p = K.makeProject();
    assert.throws(() => p.ctx.store.tx(() => {
      appendEvent(p.ctx, { type: 'a.b', actor: 'human:t' });
      throw new Error('boom');
    }), /boom/);
    assert.equal(p.ctx.store.get('SELECT COUNT(*) AS n FROM events').n, 0);
    appendEvent(p.ctx, { type: 'a.b', actor: 'human:t' });
    assert.equal(verifyLedger(p.ctx.store).ok, true);
  });
});

describe('independent anchor (audit checkpoint)', () => {
  const { ledgerCheckpoint, readCheckpoint, verifyAgainstAnchor } = K.ledger;
  const anchored = (n = 6) => {
    const { p, pub } = seeded(n);
    return { p, pub, anchor: ledgerCheckpoint(p.ctx.store, pub) };
  };
  // An attacker who controls the store and holds a signing key: rewrite the payload of
  // `fromSeq` and rebuild every later hash and signature, so the forged chain verifies alone.
  function forge(store, privateKey, fromSeq) {
    dropTriggers(store);
    let prev = GENESIS;
    for (const row of store.all('SELECT * FROM events ORDER BY seq')) {
      if (row.seq < fromSeq) {
        prev = row.hash;
        continue;
      }
      const body = {
        schema_version: row.schema_version, id: row.id, type: row.type, run_id: row.run_id, campaign_id: row.campaign_id,
        slice_id: row.slice_id, actor: row.actor, capability_id: row.capability_id,
        scope: row.scope && JSON.parse(row.scope), budget: row.budget && JSON.parse(row.budget),
        policy_decision: row.policy_decision && JSON.parse(row.policy_decision),
        payload: row.seq === fromSeq ? { forged: true } : JSON.parse(row.payload), at: row.at, prev_hash: prev,
      };
      const hash = K.canonical.digest(body);
      store.run('UPDATE events SET payload = ?, prev_hash = ?, hash = ?, signature = ? WHERE seq = ?', K.canonical.canonicalJSON(body.payload), prev, hash, K.keys.signText(privateKey, hash), row.seq);
      prev = hash;
    }
  }
  const truncate = (store) => {
    dropTriggers(store);
    store.run('DELETE FROM events WHERE seq = (SELECT MAX(seq) FROM events)');
  };
  const swapKey = (store) => {
    const attacker = generateKeyPairSync('ed25519').privateKey;
    forge(store, attacker, 1);
    store.meta('audit_public_key', K.keys.publicKeyOf(attacker));
  };

  test('a checkpoint verifies, and still does after the ledger grows', () => {
    const { p, anchor } = anchored();
    assert.equal(anchor.count, 6);
    assert.equal(verifyAgainstAnchor(p.ctx.store, anchor).ok, true);
    appendEvent(p.ctx, { type: 'test.later', actor: 'human:t' });
    const r = verifyAgainstAnchor(p.ctx.store, anchor);
    assert.equal(r.ok, true);
    assert.equal(r.count, 7);
    assert.deepEqual(r.anchored, { count: 6, head: anchor.head });
  });

  test('truncating the last event fails as truncated', () => {
    const { p, anchor } = anchored();
    truncate(p.ctx.store);
    assert.equal(verifyLedger(p.ctx.store, anchor.audit_public_key).ok, true, 'the shortened chain is valid on its own');
    assert.equal(verifyAgainstAnchor(p.ctx.store, anchor).reason, 'truncated');
  });

  test('rewriting one event fails as rewritten, even when the attacker holds the audit key', () => {
    const plain = anchored();
    dropTriggers(plain.p.ctx.store);
    plain.p.ctx.store.run('UPDATE events SET payload = ? WHERE seq = 3', '{"i":999}');
    assert.equal(verifyAgainstAnchor(plain.p.ctx.store, plain.anchor).reason, 'rewritten');

    const { p, pub, anchor } = anchored();
    forge(p.ctx.store, K.keys.auditPrivateKey(p.ctx.projectId), 3);
    assert.equal(verifyLedger(p.ctx.store, pub).ok, true, 'with the real key the forged chain verifies against itself');
    const r = verifyAgainstAnchor(p.ctx.store, anchor);
    assert.equal(r.reason, 'rewritten');
    assert.match(r.detail, /event 6 is not the anchored head/);
  });

  test('swapping the audit key fails as key', () => {
    const { p, anchor } = anchored();
    swapKey(p.ctx.store);
    assert.equal(verifyLedger(p.ctx.store, p.ctx.store.meta('audit_public_key')).ok, true, 'self-consistent under the swapped key');
    assert.equal(verifyAgainstAnchor(p.ctx.store, anchor).reason, 'key');
  });

  test('truncation, a rewrite and a key swap give three distinct reasons', () => {
    const t = anchored();
    truncate(t.p.ctx.store);
    const w = anchored();
    forge(w.p.ctx.store, K.keys.auditPrivateKey(w.p.ctx.projectId), 2);
    const k = anchored();
    swapKey(k.p.ctx.store);
    const reasons = [t, w, k].map((x) => verifyAgainstAnchor(x.p.ctx.store, x.anchor).reason);
    assert.deepEqual(reasons, ['truncated', 'rewritten', 'key']);
  });

  test('an attacker who controls the store cannot make it pass the operator\'s anchor', () => {
    // The attacker rewrites history with the real audit key, then mints a fresh checkpoint
    // from the forged store. That checkpoint passes, but it is not the one the operator kept.
    const { p, anchor } = anchored();
    forge(p.ctx.store, K.keys.auditPrivateKey(p.ctx.projectId), 1);
    const forgedAnchor = ledgerCheckpoint(p.ctx.store, anchor.audit_public_key);
    assert.equal(verifyAgainstAnchor(p.ctx.store, forgedAnchor).ok, true);
    assert.notEqual(forgedAnchor.head, anchor.head, 'no rewrite reproduces the anchored head');
    assert.equal(verifyAgainstAnchor(p.ctx.store, anchor).ok, false);
    // Appending more events on top of the forgery does not help either.
    appendEvent(p.ctx, { type: 'test.cover', actor: 'human:t' });
    assert.equal(verifyAgainstAnchor(p.ctx.store, anchor).reason, 'rewritten');
  });

  test('a tampered anchor fails too', () => {
    const { p, anchor } = anchored();
    assert.equal(verifyAgainstAnchor(p.ctx.store, { ...anchor, head: 'sha256:00' }).reason, 'rewritten');
    assert.equal(verifyAgainstAnchor(p.ctx.store, { ...anchor, count: 7 }).reason, 'truncated');
    assert.equal(verifyAgainstAnchor(p.ctx.store, { ...anchor, count: 5 }).reason, 'rewritten', 'the head is bound to its position');
    const other = K.makeProject();
    assert.equal(verifyAgainstAnchor(p.ctx.store, { ...anchor, audit_public_key: other.ctx.store.meta('audit_public_key') }).reason, 'key');
  });

  test('anchor files are validated before use', () => {
    const { p, pub } = seeded(2);
    const file = join(p.dir, 'anchor.json');
    writeFileSync(file, JSON.stringify(ledgerCheckpoint(p.ctx.store, pub)));
    assert.equal(readCheckpoint(file).count, 2);
    for (const bad of ['not json', '{}', JSON.stringify({ format: 'unknot-audit-checkpoint', version: 1, count: -1, head: 'x', audit_public_key: 'k' })]) {
      writeFileSync(file, bad);
      assert.throws(() => readCheckpoint(file), (e) => e.code === 'UK_CONFIG_INVALID');
    }
    assert.throws(() => readCheckpoint(join(p.dir, 'missing.json')), (e) => e.code === 'UK_NOT_FOUND');
    assert.throws(() => ledgerCheckpoint(p.ctx.store, null), (e) => e.code === 'UK_INTEGRITY');
  });
});
