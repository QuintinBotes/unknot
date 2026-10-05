import { db } from './db.js';

export async function handle(req) {
  await db.query("UPDATE orders SET shipped = true WHERE id = $1", [req.id]);
  return { ok: true };
}
