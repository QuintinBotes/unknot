#!/usr/bin/env python3
"""Structural extractor for the Unknot Python adapter.

Reads a JSON array of {"path": str, "text": str} from stdin and writes one JSON line per
file with raw structural data. It only ever calls ast.parse on the supplied text: it never
reads a file, never imports, compiles to a code object, or executes anything it is given.
Repository text is data; a failure on one file is reported for that file and never stops
the batch.
"""
import ast
import json
import re
import sys
import warnings

warnings.simplefilter('ignore')
sys.setrecursionlimit(3000)

MAX_CALLS = 500       # distinct call names kept per function
MAX_DETAIL = 1500     # call sites with arguments kept per file
MAX_ITEMS = 300       # sql / env / security entries kept per file
MAX_STR = 500

SQL_RE = re.compile(
    r'^\s*(?:SELECT\b.*?\bFROM\b|INSERT\s+(?:OR\s+\w+\s+)?INTO\b|UPDATE\b.*?\bSET\b|DELETE\s+FROM\b'
    r'|WITH\b.*?\bAS\s*\(|(?:CREATE|ALTER)\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:TEMP(?:ORARY)?\s+)?'
    r'(?:TABLE|INDEX|VIEW|SEQUENCE|TRIGGER|FUNCTION|SCHEMA|EXTENSION|TYPE|DATABASE)\b)',
    re.I | re.S)

FUNC_TYPES = (ast.FunctionDef, ast.AsyncFunctionDef)
MATCH = getattr(ast, 'Match', None)
WILDCARD = getattr(ast, 'MatchAs', None)


def dotted(node):
    """Dotted name of a Name/Attribute chain, or None when the base is not a plain name."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return '.'.join(reversed(parts))
    return None


def unparse(node, limit=160):
    try:
        return ast.unparse(node)[:limit]
    except Exception:
        return '?'


def enc(node, depth=0):
    """Encode an expression as JSON: literals as-is, names as {ref}, calls as {call,args,kwargs}."""
    if isinstance(node, ast.Constant):
        v = node.value
        if isinstance(v, str):
            return v[:MAX_STR]
        if v is None or isinstance(v, (bool, int, float)):
            return v
        return {'expr': type(v).__name__}
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub) and isinstance(node.operand, ast.Constant) \
            and isinstance(node.operand.value, (int, float)):
        return -node.operand.value
    if isinstance(node, (ast.Name, ast.Attribute)):
        d = dotted(node)
        return {'ref': d} if d else {'expr': unparse(node)}
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return [enc(e, depth + 1) for e in node.elts[:30]]
    if isinstance(node, ast.JoinedStr):
        return {'fstring': fstring_text(node)}
    if isinstance(node, ast.Call) and depth < 3:
        args, kwargs = call_args(node, depth + 1)
        return {'call': dotted(node.func) or '?', 'args': args, 'kwargs': kwargs}
    return {'expr': unparse(node)}


def call_args(call, depth=0):
    args = [enc(a, depth) for a in call.args[:20]]
    kwargs = {}
    for k in call.keywords[:30]:
        if k.arg is not None:
            kwargs[k.arg] = enc(k.value, depth)
    return args, kwargs


def fstring_text(node):
    out = []
    for v in node.values:
        if isinstance(v, ast.Constant) and isinstance(v.value, str):
            out.append(v.value)
        else:
            out.append('{}')
    return ''.join(out)[:MAX_STR]


def decorator_record(d):
    if isinstance(d, ast.Call):
        args, kwargs = call_args(d)
        return {'name': dotted(d.func) or unparse(d.func, 80), 'args': args, 'kwargs': kwargs, 'line': d.lineno}
    return {'name': dotted(d) or unparse(d, 80), 'args': [], 'kwargs': {}, 'line': d.lineno}


JUMPS = ((ast.Return, 'return'), (ast.Raise, 'raise'), (ast.Continue, 'continue'), (ast.Break, 'break'))
MAX_UNREACHABLE = 20


def unreachable_in(fn):
    """Statements that follow return/raise/continue/break in the same body list.

    Only the first statement after the jump is recorded per list. Nested defs and classes
    are separate functions and are not entered; sibling bodies (else, except, case) are
    different lists, so a raise in one never makes another dead.
    """
    out = []

    def lists(node):
        for field in ('body', 'orelse', 'finalbody'):
            val = getattr(node, field, None)
            if isinstance(val, list) and val and isinstance(val[0], ast.stmt):
                yield val
        for h in getattr(node, 'handlers', None) or []:
            yield h.body
        for c in getattr(node, 'cases', None) or []:
            yield c.body

    def walk(stmts):
        for i, st in enumerate(stmts):
            if len(out) >= MAX_UNREACHABLE:
                return
            for typ, name in JUMPS:
                if isinstance(st, typ):
                    if i + 1 < len(stmts):
                        out.append({'line': stmts[i + 1].lineno, 'after': name})
                    break
            else:
                if not isinstance(st, FUNC_TYPES + (ast.ClassDef,)):
                    for sub in lists(st):
                        walk(sub)
                continue
            return

    walk(fn.body)
    return out


class Metrics(object):
    """McCabe, Sonar-style cognitive complexity and max nesting for one function body."""

    def __init__(self):
        self.cc = 1
        self.cog = 0
        self.depth = 0
        self.skip = set()

    def run(self, fn):
        for s in fn.body:
            self.v(s, 0, 0)
        return self.cc, self.cog, self.depth

    def body(self, stmts, d, c):
        for s in stmts:
            self.v(s, d, c)

    def v(self, n, d, c):
        # d is structural depth (max_nesting); c is the cognitive nesting level, which try and
        # with do not raise (Sonar) but if/loops/except/match/ternary do.
        if isinstance(n, FUNC_TYPES + (ast.ClassDef,)):
            return  # nested definitions are measured on their own
        if isinstance(n, ast.If):
            self.depth = max(self.depth, d + 1)
            self.cc += 1
            self.cog += 1 + c
            self.v(n.test, d, c)
            self.body(n.body, d + 1, c + 1)
            first = n
            o = n.orelse
            while o:
                # An elif parses as a lone If in orelse that starts at the same column as its parent.
                if len(o) == 1 and isinstance(o[0], ast.If) and o[0].col_offset == first.col_offset:
                    e = o[0]
                    self.cc += 1
                    self.cog += 1
                    self.v(e.test, d, c)
                    self.body(e.body, d + 1, c + 1)
                    first = e
                    o = e.orelse
                else:
                    self.cog += 1
                    self.body(o, d + 1, c + 1)
                    break
        elif isinstance(n, (ast.For, ast.AsyncFor, ast.While)):
            self.depth = max(self.depth, d + 1)
            self.cc += 1
            self.cog += 1 + c
            for f in ('target', 'iter', 'test'):
                if getattr(n, f, None) is not None:
                    self.v(getattr(n, f), d, c)
            self.body(n.body, d + 1, c + 1)
            self.body(n.orelse, d + 1, c + 1)
        elif isinstance(n, ast.Try) or n.__class__.__name__ == 'TryStar':
            self.depth = max(self.depth, d + 1)
            self.body(n.body, d + 1, c)
            for h in n.handlers:
                self.cc += 1
                self.cog += 1 + c
                if h.type is not None:
                    self.v(h.type, d, c)
                self.body(h.body, d + 1, c + 1)
            self.body(n.orelse, d + 1, c)
            self.body(n.finalbody, d + 1, c)
        elif isinstance(n, (ast.With, ast.AsyncWith)):
            self.depth = max(self.depth, d + 1)
            for i in n.items:
                self.v(i.context_expr, d, c)
            self.body(n.body, d + 1, c)
        elif MATCH is not None and isinstance(n, MATCH):
            self.depth = max(self.depth, d + 1)
            self.cog += 1 + c
            self.v(n.subject, d, c)
            for case in n.cases:
                wild = isinstance(case.pattern, WILDCARD) and case.pattern.pattern is None and case.guard is None
                if not wild:
                    self.cc += 1
                if case.guard is not None:
                    self.v(case.guard, d, c)
                self.body(case.body, d + 1, c + 1)
        elif isinstance(n, ast.IfExp):
            self.cc += 1
            self.cog += 1 + c
            self.v(n.test, d, c)
            self.v(n.body, d, c + 1)
            self.v(n.orelse, d, c + 1)
        elif isinstance(n, ast.BoolOp):
            self.cc += len(n.values) - 1
            if id(n) not in self.skip:
                self.cog += 1
            for val in n.values:
                if isinstance(val, ast.BoolOp) and type(val.op) is type(n.op):
                    self.skip.add(id(val))
                self.v(val, d, c)
        elif isinstance(n, ast.comprehension):
            self.cc += 1 + len(n.ifs)
            for ch in ast.iter_child_nodes(n):
                self.v(ch, d, c)
        else:
            for ch in ast.iter_child_nodes(n):
                self.v(ch, d, c)


class Analyzer(object):
    def __init__(self, path, text, tree):
        self.path = path
        self.tree = tree
        self.functions = []
        self.classes = []
        self.imports = []
        self.sql = []
        self.env = []
        self.security = []
        self.detail = []
        self.module_calls = []
        self.module_call_set = set()
        self.assign_of = {}
        # Occurrences of each name as a Name or attribute in the file: a function referenced
        # by value (`map(total)`, a callback, a registry dict) is used even with no call.
        self.name_counts = {}
        for node in ast.walk(tree):
            key = node.id if isinstance(node, ast.Name) else node.attr if isinstance(node, ast.Attribute) else None
            if key is not None:
                self.name_counts[key] = self.name_counts.get(key, 0) + 1
        self.docs = set()
        self.stack = []  # (kind, qual, record)
        self.fn_calls = {}
        for n in ast.walk(tree):
            if isinstance(n, (ast.Module, ast.ClassDef) + FUNC_TYPES) and n.body:
                f = n.body[0]
                if isinstance(f, ast.Expr) and isinstance(f.value, ast.Constant) and isinstance(f.value.value, str):
                    self.docs.add(id(f.value))

    def qual(self, name):
        return (self.stack[-1][1] + '.' + name) if self.stack else name

    def scope_fn(self):
        for kind, qual, _ in reversed(self.stack):
            if kind == 'fn':
                return qual
            if kind == 'cls':
                return None
        return None

    def owner_class(self):
        if self.stack and self.stack[-1][0] == 'cls':
            return self.stack[-1][1]
        return None

    def add_sec(self, kind, line, **extra):
        if len(self.security) < MAX_ITEMS:
            rec = {'kind': kind, 'line': line, 'scope': self.scope_fn()}
            rec.update(extra)
            self.security.append(rec)

    def run(self):
        self.visit(self.tree)

    # -- generic walk -----------------------------------------------------------------
    def visit(self, n):
        if isinstance(n, FUNC_TYPES):
            return self.on_function(n)
        if isinstance(n, ast.ClassDef):
            return self.on_class(n)
        if isinstance(n, ast.Import):
            for a in n.names:
                self.imports.append({'kind': 'import', 'level': 0, 'module': a.name, 'as': a.asname, 'names': [], 'line': n.lineno})
        elif isinstance(n, ast.ImportFrom):
            self.imports.append({'kind': 'from', 'level': n.level or 0, 'module': n.module or '',
                                 'names': [{'name': a.name, 'as': a.asname} for a in n.names], 'line': n.lineno})
        elif isinstance(n, ast.Assign):
            if isinstance(n.value, ast.Call) and len(n.targets) == 1:
                t = n.targets[0]
                self.assign_of[id(n.value)] = (t.id if isinstance(t, ast.Name) else None, None)
        elif isinstance(n, ast.AnnAssign):
            if isinstance(n.value, ast.Call):
                t = n.target
                self.assign_of[id(n.value)] = (t.id if isinstance(t, ast.Name) else None, unparse(n.annotation, 120))
        elif isinstance(n, ast.Call):
            self.on_call(n)
        elif isinstance(n, ast.Subscript):
            self.on_subscript(n)
        elif isinstance(n, ast.Constant):
            if isinstance(n.value, str) and id(n) not in self.docs:
                self.on_string(n.value, n.lineno)
            return
        elif isinstance(n, ast.JoinedStr):
            self.on_string(fstring_text(n), n.lineno)
            for v in n.values:
                if isinstance(v, ast.FormattedValue):
                    self.visit(v)
            return
        for ch in ast.iter_child_nodes(n):
            self.visit(ch)

    def on_string(self, s, line):
        if len(self.sql) < MAX_ITEMS and len(s) >= 12 and SQL_RE.match(s):
            self.sql.append({'line': line, 'text': s[:MAX_STR]})

    def on_subscript(self, n):
        if dotted(n.value) in ('os.environ', 'environ') and isinstance(n.slice, ast.Constant) \
                and isinstance(n.slice.value, str) and len(self.env) < MAX_ITEMS:
            self.env.append({'name': n.slice.value, 'line': n.lineno, 'required': True})

    def on_function(self, n):
        qual = self.qual(n.name)
        parent = self.stack[-1][1] if self.stack else None
        in_class = bool(self.stack) and self.stack[-1][0] == 'cls'
        decs = [decorator_record(d) for d in n.decorator_list]
        names = [d['name'] for d in decs]
        a = n.args
        params = [p.arg for p in a.posonlyargs + a.args + a.kwonlyargs]
        if a.vararg:
            params.append('*' + a.vararg.arg)
        if a.kwarg:
            params.append('**' + a.kwarg.arg)
        if in_class and params and params[0] in ('self', 'cls') and 'staticmethod' not in names:
            params = params[1:]
        # Required parameters: positional ones without a default, and keyword-only ones
        # without a default. Optional keyword-only parameters (`*, x=None`) cannot be
        # passed in the wrong order, so they do not count toward a long parameter list.
        positional = a.posonlyargs + a.args
        n_pos_defaults = len(a.defaults)
        required_pos = positional[:len(positional) - n_pos_defaults] if n_pos_defaults else positional
        required = [p.arg for p in required_pos] + [k.arg for k, d in zip(a.kwonlyargs, a.kw_defaults) if d is None]
        if in_class and required and required[0] in ('self', 'cls') and 'staticmethod' not in names:
            required = required[1:]
        kind = 'method' if in_class else 'function'
        for want in ('staticmethod', 'classmethod', 'property'):
            if in_class and want in names:
                kind = want
        try:
            cc, cog, depth = Metrics().run(n)
        except RecursionError:
            cc, cog, depth = 1, 0, 0
        end = getattr(n, 'end_lineno', n.lineno) or n.lineno
        rec = {'name': n.name, 'qual': qual, 'parent': parent, 'in_class': in_class, 'kind': kind,
               'start_line': n.lineno, 'end_line': end, 'params': params, 'params_required': len(required), 'cyclomatic': cc, 'cognitive': cog,
               'max_nesting': depth, 'decorators': decs, 'async': isinstance(n, ast.AsyncFunctionDef),
               'returns': unparse(n.returns, 120) if n.returns is not None else None, 'calls': [],
               'unreachable': unreachable_in(n), 'name_occurrences': self.name_counts.get(n.name, 0)}
        self.functions.append(rec)
        self.fn_calls[qual] = (rec, set())
        for d in n.decorator_list:
            self.visit(d)
        for dflt in a.defaults + [x for x in a.kw_defaults if x is not None]:
            self.visit(dflt)
        self.stack.append(('fn', qual, rec))
        for s in n.body:
            self.visit(s)
        self.stack.pop()

    def on_class(self, n):
        qual = self.qual(n.name)
        assigns = {}
        for s in n.body:
            if len(assigns) >= 60:
                break
            if isinstance(s, ast.Assign) and len(s.targets) == 1 and isinstance(s.targets[0], ast.Name):
                assigns[s.targets[0].id] = enc(s.value)
            elif isinstance(s, ast.AnnAssign) and isinstance(s.target, ast.Name) and s.value is not None:
                assigns[s.target.id] = enc(s.value)
        kws = {k.arg: enc(k.value) for k in n.keywords if k.arg}
        end = getattr(n, 'end_lineno', n.lineno) or n.lineno
        self.classes.append({'name': n.name, 'qual': qual, 'parent': self.stack[-1][1] if self.stack else None,
                             'start_line': n.lineno, 'end_line': end,
                             'bases': [dotted(b) or unparse(b, 80) for b in n.bases],
                             'keywords': kws, 'decorators': [decorator_record(d) for d in n.decorator_list],
                             'assigns': assigns})
        for d in n.decorator_list:
            self.visit(d)
        for b in n.bases:
            self.visit(b)
        self.stack.append(('cls', qual, None))
        for s in n.body:
            self.visit(s)
        self.stack.pop()

    # -- calls ------------------------------------------------------------------------
    def on_call(self, n):
        name = dotted(n.func)
        line = n.lineno
        fn = self.scope_fn()
        if name:
            if fn is not None:
                rec, seen = self.fn_calls[fn]
                if name not in seen and len(seen) < MAX_CALLS:
                    seen.add(name)
                    rec['calls'].append(name)
            elif name not in self.module_call_set and len(self.module_call_set) < MAX_CALLS:
                self.module_call_set.add(name)
                self.module_calls.append(name)
            self.on_named_call(n, name, line)
        self.on_execute(n, line)
        if (n.args or n.keywords or id(n) in self.assign_of) and name and len(self.detail) < MAX_DETAIL:
            args, kwargs = call_args(n)
            tgt, ann = self.assign_of.get(id(n), (None, None))
            self.detail.append({'name': name, 'args': args, 'kwargs': kwargs, 'line': line, 'scope': fn,
                                'owner_class': self.owner_class(), 'assign': tgt, 'ann': ann})

    def on_named_call(self, n, name, line):
        kw = {k.arg: k.value for k in n.keywords if k.arg}
        if name in ('os.getenv', 'getenv', 'os.environ.get', 'environ.get') and n.args \
                and isinstance(n.args[0], ast.Constant) and isinstance(n.args[0].value, str) and len(self.env) < MAX_ITEMS:
            self.env.append({'name': n.args[0].value, 'line': line, 'required': False})
        if name.startswith('subprocess.') or name in ('Popen', 'run', 'call', 'check_call', 'check_output'):
            sh = kw.get('shell')
            if isinstance(sh, ast.Constant) and sh.value is True:
                self.add_sec('shell_true', line, name=name)
        if name == 'os.system':
            self.add_sec('os_system', line, name=name)
        elif name in ('os.popen', 'popen'):
            self.add_sec('os_popen', line, name=name)
        elif name in ('eval', 'exec'):
            self.add_sec(name, line, name=name)
        elif name in ('pickle.loads', 'pickle.load', 'cPickle.loads', 'cPickle.load', '_pickle.loads', '_pickle.load'):
            self.add_sec('pickle_load', line, name=name)
        elif name in ('marshal.loads', 'marshal.load'):
            self.add_sec('marshal_load', line, name=name)
        elif name == 'yaml.unsafe_load':
            self.add_sec('yaml_unsafe_load', line, name=name)
        elif name == 'yaml.load':
            loader = kw.get('Loader')
            if loader is None and len(n.args) > 1:
                loader = n.args[1]
            text = unparse(loader) if loader is not None else ''
            if 'SafeLoader' not in text:
                self.add_sec('yaml_unsafe_load', line, name=name)

    def on_execute(self, n, line):
        f = n.func
        if not (isinstance(f, ast.Attribute) and f.attr in ('execute', 'executemany', 'executescript', 'raw')) or not n.args:
            return
        a = n.args[0]
        how = None
        if isinstance(a, ast.JoinedStr) and any(isinstance(v, ast.FormattedValue) for v in a.values):
            how = 'fstring'
        elif isinstance(a, ast.BinOp) and isinstance(a.op, ast.Mod) and isinstance(a.left, ast.Constant) \
                and isinstance(a.left.value, str):
            how = 'percent'
        elif isinstance(a, ast.BinOp) and isinstance(a.op, ast.Add) and (
                (isinstance(a.left, ast.Constant) and isinstance(a.left.value, str) and not isinstance(a.right, ast.Constant))
                or (isinstance(a.right, ast.Constant) and isinstance(a.right.value, str) and not isinstance(a.left, ast.Constant))):
            how = 'concat'
        elif isinstance(a, ast.Call) and isinstance(a.func, ast.Attribute) and a.func.attr == 'format' \
                and isinstance(a.func.value, ast.Constant) and isinstance(a.func.value.value, str):
            how = 'format'
        if how:
            self.add_sec('sql_injection', line, name=dotted(f) or f.attr, how=how)


def analyze(path, text):
    tree = ast.parse(text, filename='<unknot>')
    an = Analyzer(path, text, tree)
    an.run()
    lines = text.splitlines()
    sloc = sum(1 for ln in lines if ln.strip() and not ln.strip().startswith('#'))
    return {'path': path, 'loc': len(lines), 'sloc': sloc, 'functions': an.functions, 'classes': an.classes,
            'imports': an.imports, 'calls': an.module_calls, 'calls_detail': an.detail, 'sql': an.sql,
            'env': an.env, 'security': an.security}


def process(item):
    path = item.get('path') if isinstance(item, dict) else None
    if not isinstance(path, str):
        return None
    text = item.get('text')
    if not isinstance(text, str):
        return {'path': path, 'error': {'line': 0, 'msg': 'text is not a string'}}
    try:
        return analyze(path, text)
    except SyntaxError as e:
        return {'path': path, 'error': {'line': int(e.lineno or 0), 'msg': str(e.msg)[:200]}}
    except BaseException as e:  # never let one hostile file end the batch
        if isinstance(e, KeyboardInterrupt):
            raise
        return {'path': path, 'error': {'line': 0, 'msg': '%s: %s' % (type(e).__name__, str(e)[:160])}}


def main():
    try:
        items = json.loads(sys.stdin.buffer.read().decode('utf-8', 'replace'))
        if not isinstance(items, list):
            raise ValueError('input must be a JSON array')
    except Exception as e:
        sys.stderr.write('extract.py: bad input: %s\n' % e)
        return 2
    out = sys.stdout
    for item in items:
        rec = process(item)
        if rec is not None:
            out.write(json.dumps(rec, ensure_ascii=True, separators=(',', ':')) + '\n')
    out.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
