import { db } from './db.js';

export async function handle(req) {
  await db.query("UPDATE orders SET paid = true WHERE id = $1", [req.id]);
  return { ok: true };
}
