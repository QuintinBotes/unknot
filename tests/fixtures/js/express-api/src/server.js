const express = require('express');
const { exec } = require('child_process');
const db = require('./db');

const app = express();
const router = express.Router();

router.get('/orders/:id', async (req, res) => {
  const row = await db.query(`SELECT * FROM orders WHERE id = ${req.params.id}`);
  res.json(row);
});

router.post('/orders', validate, createOrder);

app.get('/health', (req, res) => res.send('ok'));
app.route('/items').get(listItems).post(createItem);
app.use('/api', router);

function validate(req, res, next) {
  if (!req.body) {
    return res.status(400).end();
  }
  next();
}

function createOrder(req, res) {
  db.execute('INSERT INTO orders (sku, qty) VALUES ($1, $2)', [req.body.sku, req.body.qty]);
  exec(`convert ${req.body.file} out.png`);
  res.status(201).end();
}

function listItems(req, res) {
  res.json([]);
}

function createItem(req, res) {
  res.status(201).end();
}

app.listen(process.env.PORT || 3000);

module.exports = app;
