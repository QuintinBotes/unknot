from .. import config


class Normalizer:
    def clean(self, value):
        return str(value).strip()


def normalize(value):
    if value is None:
        return config.URL
    return str(value).lower()
