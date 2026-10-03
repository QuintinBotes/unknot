def simple(a):
    return a


def branchy(a, b):
    if a and b:
        for x in a:
            if x:
                pass
    elif b:
        pass
    else:
        pass


async def fetch(url, *rest, timeout=3, **opts) -> bytes:
    try:
        return await get(url)
    except ValueError:
        return b''
