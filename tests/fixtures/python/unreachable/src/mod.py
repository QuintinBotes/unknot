def after_return(x):
    return x
    print("never")


def after_raise(x):
    if x:
        raise ValueError(x)
        cleanup()
    return 1


def loop(items):
    for i in items:
        if i:
            continue
            print("skipped")
        break
        print("after break")


def raise_then_else(x):
    if x:
        raise ValueError(x)
    else:
        return 2


def early(x):
    if x:
        return 1
    return 2


def outer():
    def inner():
        return 1
    return inner


def cleanup():
    pass
