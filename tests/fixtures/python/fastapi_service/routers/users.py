from fastapi import APIRouter

from celery import shared_task

router = APIRouter()


@router.get('/')
def list_users():
    return []


@router.delete('/{user_id}')
def delete_user(user_id: int):
    return {'deleted': user_id}


@shared_task
def send_welcome(user_id):
    return user_id
