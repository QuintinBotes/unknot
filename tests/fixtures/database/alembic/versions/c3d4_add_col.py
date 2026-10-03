"""add column"""
import sqlalchemy as sa
from alembic import op

revision = 'c3d4'
down_revision = 'a1b2'


def upgrade():
    op.add_column('accounts', sa.Column('active', sa.Boolean(), server_default=sa.text('true'), nullable=False))
    op.alter_column('accounts', 'name', type_=sa.String(200), existing_type=sa.String(50))
    op.execute("UPDATE accounts SET active = true")


def downgrade():
    pass
