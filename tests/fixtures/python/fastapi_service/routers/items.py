from fastapi import APIRouter
from kafka import KafkaProducer

router = APIRouter(prefix='/items', tags=['items'])
producer = KafkaProducer(bootstrap_servers='localhost:9092')


@router.get('/{item_id}')
async def read_item(item_id: int) -> dict:
    return {'id': item_id}


@router.post('/')
async def create_item(payload: dict):
    producer.send('item-events', payload)
    return payload
