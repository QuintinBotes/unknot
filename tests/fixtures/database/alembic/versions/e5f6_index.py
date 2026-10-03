"""index"""
from alembic import op

revision = 'e5f6'
down_revision = 'c3d4'


def upgrade():
    op.create_index('ix_accounts_name', 'accounts', ['name'], postgresql_concurrently=True)


def downgrade():
    op.drop_index('ix_accounts_name', postgresql_concurrently=True)
