import { Kafka } from 'kafkajs';
const kafka = new Kafka({ clientId: 'x', brokers: ['kafka:9092'] });
const consumer = kafka.consumer({ groupId: 'shipping' });
const producer = kafka.producer();

export async function start() {
  await consumer.subscribe({ topic: 'orders.created' });
  await producer.send({ topic: 'inventory.adjusted', messages: [] });
}
