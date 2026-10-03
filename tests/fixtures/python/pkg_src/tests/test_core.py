import pytest

from acme.core import run


def test_run():
    assert run('X') is not None
