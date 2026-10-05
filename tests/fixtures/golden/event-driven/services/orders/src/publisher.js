import { Kafka } from 'kafkajs';
const kafka = new Kafka({ clientId: 'x', brokers: ['kafka:9092'] });
const producer = kafka.producer();

export async function orderCreated(order) {
  await producer.send({ topic: 'orders.created', messages: [{ value: JSON.stringify(order) }] });
}

export async function orderCancelled(order) {
  await producer.send({ topic: 'orders.cancelled', messages: [{ value: JSON.stringify(order) }] });
}
