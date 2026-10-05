import { Kafka } from 'kafkajs';
const kafka = new Kafka({ clientId: 'x', brokers: ['kafka:9092'] });
const consumer = kafka.consumer({ groupId: 'billing' });

export async function start() {
  await consumer.subscribe({ topic: 'orders.created' });
  await consumer.subscribe({ topic: 'inventory.adjusted' });
}
