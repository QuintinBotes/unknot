import amqp from 'amqplib';

export async function start() {
  const conn = await amqp.connect('amqp://rabbit');
  const ch = await conn.createChannel();
  await ch.consume('emails', (msg) => msg);
  await ch.sendToQueue('emails', Buffer.from('x'));
}
