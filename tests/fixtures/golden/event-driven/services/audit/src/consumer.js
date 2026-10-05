import { Kafka } from 'kafkajs';
const kafka = new Kafka({ clientId: 'x', brokers: ['kafka:9092'] });
const consumer = kafka.consumer({ groupId: 'audit' });

export async function start() {
  await consumer.subscribe({ topic: 'inventory.adjusted' });
  await consumer.subscribe({ topic: 'orders.created' });
}
