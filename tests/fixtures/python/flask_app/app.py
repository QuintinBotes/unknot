import os
import subprocess

from flask import Flask

from auth.routes import auth_bp
from models import db

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ['SECRET_KEY']
app.config['DATABASE_URL'] = os.getenv('DATABASE_URL')
app.register_blueprint(auth_bp, url_prefix='/api/v1')


@app.route('/health')
def health():
    return {'ok': True}


@app.route('/orders/<int:order_id>', methods=['GET', 'DELETE'])
def order(order_id):
    if order_id < 0 or order_id > 10000:
        return {'error': 'bad id'}, 400
    return {'id': order_id}


@app.post('/deploy')
def deploy():
    # shell=True with request data is the classic injection hole
    subprocess.run('make deploy', shell=True)
    return {'started': True}
