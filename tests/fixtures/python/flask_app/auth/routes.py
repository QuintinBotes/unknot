from flask import Blueprint

from models import User

auth_bp = Blueprint('auth', __name__, url_prefix='/auth')


@auth_bp.get('/me')
def me():
    return User.find(1)


@auth_bp.route('/login', methods=['POST'])
def login():
    return {'token': 'x'}
