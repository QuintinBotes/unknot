import { Kafka } from 'kafkajs';
import { Queue, Worker } from 'bullmq';

const kafka = new Kafka({ brokers: [] });

export async function run(ch: any) {
  const producer = kafka.producer();
  await producer.send({ topic: 'orders.created', messages: [] });
  const consumer = kafka.consumer({ groupId: 'g' });
  await consumer.subscribe({ topics: ['payments', 'refunds'] });
  ch.sendToQueue('emails', Buffer.from('x'));
  ch.consume('emails', () => {});
  ch.publish('events', 'user.created', Buffer.from('x'));
}

const reports = new Queue('reports');
new Worker('reports', async () => {});
