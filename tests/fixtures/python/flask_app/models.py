from sqlalchemy import Column, ForeignKey, Integer, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = 'users'

    id = Column(Integer, primary_key=True)
    email = Column(String(120), nullable=False)
    nickname = Column(String(40))

    @classmethod
    def find(cls, user_id):
        return cls.query.get(user_id)


class Order(Base):
    __tablename__ = 'orders'

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id'))
    note: Mapped[str | None] = mapped_column(String(200))
    owner = relationship('User')


class _Registry:
    db = None


db = _Registry()
