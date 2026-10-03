"""init"""
import sqlalchemy as sa
from alembic import op

revision = 'a1b2'
down_revision = None


def upgrade():
    op.create_table(
        'accounts',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('name', sa.String(50), nullable=False),
    )


def downgrade():
    op.drop_table('accounts')
