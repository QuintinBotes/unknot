from celery import Celery

app = Celery("billing")


@app.task
def charge(order_id):
    return {"order": order_id, "status": "charged"}
