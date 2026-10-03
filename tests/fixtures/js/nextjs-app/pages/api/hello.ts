export default function handler(req, res) {
  if (req.method === 'POST') {
    res.status(201).json({ ok: true });
    return;
  }
  res.status(200).json({ hello: 'world' });
}
