from fastapi import FastAPI

from routers import items, users

app = FastAPI()
app.include_router(users.router, prefix='/users')


@app.get('/ping')
async def ping():
    return {'pong': True}
