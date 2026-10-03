import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basenameOf, effectiveCommands, parseShell } from '../../../runtime/core/shell.mjs';

const parse = (cmd, opts) => {
  const r = parseShell(cmd, opts);
  assert.equal(r.ok, true, `expected ok for ${JSON.stringify(cmd)}: ${r.reason}`);
  return r.commands;
};
const vals = (cmd) => parse(cmd).map((c) => c.argv.map((w) => w.value));
const eff = (cmd) => effectiveCommands(parseShell(cmd)).map((c) => c.argv.map((w) => w.value));
const effCmds = (cmd) => effectiveCommands(parseShell(cmd));
const rejects = (cmd, opts) => {
  const r = parseShell(cmd, opts);
  assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(cmd)}`);
  assert.equal(typeof r.reason, 'string');
};

test('plain commands and words', () => {
  assert.deepEqual(vals('git status'), [['git', 'status']]);
  assert.deepEqual(vals('  ls   -la\t/tmp '), [['ls', '-la', '/tmp']]);
  assert.deepEqual(vals(''), []);
  assert.deepEqual(vals('   \n\n  '), []);
  const [c] = parse('ls');
  assert.deepEqual(c.argv[0], { value: 'ls', dynamic: false, glob: false, quoted: false });
  assert.deepEqual(c.context, { pipeline: false, background: false, subshell: false, substitution: false, negated: false });
});

test('single quotes, double quotes and backslashes', () => {
  assert.deepEqual(vals("echo 'a b' \"c d\" e\\ f"), [['echo', 'a b', 'c d', 'e f']]);
  assert.deepEqual(vals("echo 'it''s'"), [['echo', 'its']]);
  assert.deepEqual(vals('echo "a\\"b\\$c\\\\d\\e"'), [['echo', 'a"b$c\\d\\e']]);
  assert.deepEqual(vals("echo '$HOME `x` \\n'"), [['echo', '$HOME `x` \\n']]);
  assert.deepEqual(vals("r''m -rf /"), [['rm', '-rf', '/']]);
  assert.deepEqual(vals('"r"m'), [['rm']]);
  assert.deepEqual(vals('\\rm -rf /'), [['rm', '-rf', '/']]);
  assert.deepEqual(vals("echo ''"), [['echo', '']]);
  const w = parse("echo 'a'")[0].argv[1];
  assert.equal(w.quoted, true);
  assert.equal(w.dynamic, false);
});

test('ANSI-C quoting is fully decoded', () => {
  assert.deepEqual(vals("$'\\x72m' -rf /"), [['rm', '-rf', '/']]);
  assert.deepEqual(vals("$'\\162m'"), [['rm']]);
  assert.deepEqual(vals("$'\\u0072m'"), [['rm']]);
  assert.deepEqual(vals("echo $'a\\nb\\tc\\\\d\\'e'"), [['echo', "a\nb\tc\\d'e"]]);
  assert.deepEqual(vals("echo $'\\xc3\\xa9'"), [['echo', 'é']]);
  assert.deepEqual(vals("echo $'\\e\\a'"), [['echo', '\x1b\x07']]);
  assert.equal(parse("$'rm'")[0].argv[0].dynamic, false);
  rejects("echo $'a\\x00b'");
  rejects("echo $'a\\0b'");
  rejects("echo $'abc");
});

test('locale quoting $"..." behaves like double quotes', () => {
  assert.deepEqual(vals('echo $"a b"'), [['echo', 'a b']]);
  assert.equal(parse('echo $"$X"')[0].argv[1].dynamic, true);
});

test('line continuations and comments', () => {
  assert.deepEqual(vals('echo a \\\n  b \\\nc'), [['echo', 'a', 'b', 'c']]);
  assert.deepEqual(vals('ec\\\nho hi'), [['echo', 'hi']]);
  assert.deepEqual(vals('echo hi # rm -rf /'), [['echo', 'hi']]);
  assert.deepEqual(vals('# only\nls'), [['ls']]);
  assert.deepEqual(vals('echo a#b'), [['echo', 'a#b']]);
  assert.deepEqual(vals('echo hi;# c\nls'), [['echo', 'hi'], ['ls']]);
  assert.deepEqual(vals('echo "a\\\nb"'), [['echo', 'ab']]);
});

test('operators flatten in order', () => {
  assert.deepEqual(vals('a; b && c || d | e & f\ng'), [['a'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g']]);
  assert.deepEqual(vals('a |& b'), [['a'], ['b']]);
  assert.deepEqual(vals('a &&\n b ||\n c |\n d'), [['a'], ['b'], ['c'], ['d']]);
  rejects('&& a');
  rejects('a &&');
  rejects('a |');
  rejects('a ; ; b');
  rejects(';');
  rejects('a & & b');
});

test('context flags', () => {
  const [a, b, c] = parse('a | b; c &');
  assert.equal(a.context.pipeline, true);
  assert.equal(b.context.pipeline, true);
  assert.equal(c.context.pipeline, false);
  assert.equal(c.context.background, true);
  assert.equal(a.context.background, false);
  const [n1, n2] = parse('! a | b');
  assert.equal(n1.context.negated, true);
  assert.equal(n2.context.negated, true);
  const [bg1, bg2] = parse('x && y &');
  assert.equal(bg1.context.background && bg2.context.background, true);
  const [s1] = parse('(a)');
  assert.equal(s1.context.subshell, true);
  const [g1] = parse('{ a; }');
  assert.equal(g1.context.subshell, true);
  const subs = parse('echo $(inner)');
  assert.equal(subs.find((x) => x.argv[0].value === 'inner').context.substitution, true);
  assert.equal(subs.find((x) => x.argv[0].value === 'echo').context.substitution, false);
});

test('dynamic words: parameter expansion', () => {
  for (const w of ['$X', '${X}', '${X:-y}', '$1', '$@', '$*', '$?', '$$', '$!', '$#', '"$X"', 'a$X', '${#X}', '${X%%/*}']) {
    const cmd = parse(`echo ${w}`)[0];
    assert.equal(cmd.argv[1].dynamic, true, w);
  }
  assert.equal(parse('echo $')[0].argv[1].dynamic, false);
  assert.equal(parse("echo '$X'")[0].argv[1].dynamic, false);
  assert.equal(parse('echo \\$X')[0].argv[1].dynamic, false);
  assert.equal(parse('echo \\$X')[0].argv[1].value, '$X');
  assert.deepEqual(parse('echo "${CLAUDE_PLUGIN_ROOT}/bin"')[0].argv[1].value, '${CLAUDE_PLUGIN_ROOT}/bin');
});

test('dynamic words: tilde, brace expansion', () => {
  assert.equal(parse('ls ~/x')[0].argv[1].dynamic, true);
  assert.equal(parse('ls ~')[0].argv[1].dynamic, true);
  assert.equal(parse('ls a~b')[0].argv[1].dynamic, false);
  assert.equal(parse("ls '~/x'")[0].argv[1].dynamic, false);
  assert.equal(parse('echo {a,b}')[0].argv[1].dynamic, true);
  assert.equal(parse('echo {1..3}')[0].argv[1].dynamic, true);
  assert.equal(parse('{rm,-rf,/}')[0].argv[0].dynamic, true);
  assert.equal(parse('echo {}')[0].argv[1].dynamic, false);
  assert.equal(parse('echo "{a,b}"')[0].argv[1].dynamic, false);
  assert.equal(parse('echo HEAD@{1}')[0].argv[1].dynamic, false);
});

test('glob flag', () => {
  assert.equal(parse('ls *.ts')[0].argv[1].glob, true);
  assert.equal(parse('ls a?')[0].argv[1].glob, true);
  assert.equal(parse('ls [ab]')[0].argv[1].glob, true);
  assert.equal(parse("ls '*.ts'")[0].argv[1].glob, false);
  assert.equal(parse('ls "*.ts"')[0].argv[1].glob, false);
  assert.equal(parse('ls \\*')[0].argv[1].glob, false);
  assert.equal(parse('[ -f x ]')[0].argv[0].glob, false);
});

test('assignments', () => {
  const [c] = parse('A=1 B="x y" C=$Z node app.js');
  assert.deepEqual(c.assignments.map((a) => [a.name, a.value.value, a.value.dynamic]), [['A', '1', false], ['B', 'x y', false], ['C', '$Z', true]]);
  assert.deepEqual(c.argv.map((w) => w.value), ['node', 'app.js']);
  const [only] = parse('x=1');
  assert.equal(only.argv.length, 0);
  assert.equal(only.assignments.length, 1);
  const [late] = parse('echo A=1');
  assert.equal(late.assignments.length, 0);
  assert.equal(late.argv[1].value, 'A=1');
  assert.equal(parse('P=~/bin ls')[0].assignments[0].value.dynamic, true);
  assert.equal(parse('A+=b')[0].assignments[0].name, 'A');
  rejects('a=(rm -rf /)');
  assert.deepEqual(vals('a=rm; $a -rf /'), [[], ['$a', '-rf', '/']]);
  assert.equal(parse('a=rm; $a -rf /')[1].argv[0].dynamic, true);
});

test('redirections', () => {
  const [c] = parse('cmd >out 2>err <in >>app 2>&1 &>both &>>both2 >|force 3<&0');
  assert.deepEqual(c.redirects.map((r) => [r.fd, r.op, r.target.value]), [
    [null, '>', 'out'], [2, '>', 'err'], [null, '<', 'in'], [null, '>>', 'app'], [2, '>&', '1'],
    [null, '&>', 'both'], [null, '&>>', 'both2'], [null, '>|', 'force'], [3, '<&', '0'],
  ]);
  assert.deepEqual(c.argv.map((w) => w.value), ['cmd']);
  assert.equal(parse('echo 2 > f')[0].argv.length, 2);
  assert.deepEqual(parse('cat <<< "hi there"')[0].redirects.map((r) => [r.op, r.target.value]), [['<<<', 'hi there']]);
  const [bare] = parse('> ~/.ssh/authorized_keys');
  assert.equal(bare.argv.length, 0);
  assert.equal(bare.redirects[0].target.dynamic, true);
  rejects('cat >');
  rejects('cat > ;');
  rejects('echo hi >&');
  assert.equal(parse('echo >&-')[0].redirects[0].target.value, '-');
});

test('redirection on a compound applies to its commands', () => {
  const cmds = parse('{ a; b; } > out');
  assert.equal(cmds.length, 2);
  for (const c of cmds) assert.equal(c.redirects[0].target.value, 'out');
  const loop = parse('while read l; do echo $l; done < in');
  for (const c of loop) assert.equal(c.redirects[0].target.value, 'in');
});

test('heredocs', () => {
  const [c] = parse("cat <<'EOF' > file.txt\nhello $X\nEOF\n");
  assert.equal(c.redirects[0].op, '<<');
  assert.equal(c.redirects[0].heredoc, 'hello $X\n');
  assert.equal(c.redirects[0].heredocDynamic, undefined);
  assert.equal(c.redirects[1].target.value, 'file.txt');

  const [d] = parse('cat <<EOF\nhello $X\nEOF');
  assert.equal(d.redirects[0].heredoc, 'hello $X\n');
  assert.equal(d.redirects[0].heredocDynamic, true);

  const [q] = parse('cat <<"EOF"\n$X\nEOF');
  assert.equal(q.redirects[0].heredocDynamic, undefined);

  const [plain] = parse('cat <<EOF\njust text\nEOF');
  assert.equal(plain.redirects[0].heredocDynamic, undefined);

  const [t] = parse('cat <<-EOF\n\t\tindented\n\tEOF\n');
  assert.equal(t.redirects[0].heredoc, 'indented\n');

  const cmds = parse('cat <<A <<B\none\nA\ntwo\nB\nls');
  assert.deepEqual(cmds[0].redirects.map((r) => r.heredoc), ['one\n', 'two\n']);
  assert.deepEqual(cmds[1].argv.map((w) => w.value), ['ls']);

  // Commands after the heredoc on the same line.
  const after = parse('cat <<EOF | sh\nbody\nEOF');
  assert.deepEqual(after.map((x) => x.argv[0].value), ['cat', 'sh']);

  // Substitutions inside an unquoted body run; inside a quoted body they do not.
  assert.ok(parse('cat <<EOF\n$(rm -rf /)\nEOF').some((x) => x.argv[0].value === 'rm'));
  assert.ok(!parse("cat <<'EOF'\n$(rm -rf /)\nEOF").some((x) => x.argv[0].value === 'rm'));

  rejects('cat <<EOF\nnever ends');
  rejects('cat <<EOF');
  rejects('cat <<');
});

test('subshells and groups', () => {
  assert.deepEqual(vals('(cd /; rm -rf .)'), [['cd', '/'], ['rm', '-rf', '.']]);
  assert.deepEqual(vals('{ rm -rf /; }'), [['rm', '-rf', '/']]);
  assert.deepEqual(vals('( ( a ) )'), [['a']]);
  assert.deepEqual(vals('{\n a\n b\n}'), [['a'], ['b']]);
  rejects('(a');
  rejects('a)');
  rejects('{ a');
  rejects('{ a }');
  rejects('()');
  rejects('{ ; }');
  rejects('((1+1))');
  rejects('(( x = 1 ))');
});

test('command substitution, backticks, process substitution', () => {
  const cmds = parse('$(echo rm) -rf /');
  assert.equal(cmds.at(-1).argv[0].dynamic, true);
  assert.equal(cmds.at(-1).argv[0].value, '$(echo rm)');
  assert.ok(cmds.some((c) => c.argv[0].value === 'echo' && c.context.substitution));
  assert.ok(parse('echo `rm x`').some((c) => c.argv[0].value === 'rm' && c.context.substitution));
  assert.ok(parse('echo "a $(rm x) b"').some((c) => c.argv[0].value === 'rm'));
  assert.ok(parse('diff <(sort a) >(tee b)').some((c) => c.argv[0].value === 'tee'));
  assert.equal(parse('cat <(ls)')[1].argv[1].dynamic, true);
  assert.ok(parse('echo `echo \\`rm\\``').some((c) => c.argv[0].value === 'rm'));
  assert.ok(parse('echo $(echo $(rm))').some((c) => c.argv[0].value === 'rm'));
  assert.ok(parse('echo $(case x in x) rm;; esac)').some((c) => c.argv[0].value === 'rm'));
  assert.ok(parse('echo $(echo ")" ; rm)').some((c) => c.argv[0].value === 'rm'));
  assert.ok(parse('echo ${A:-$(rm)}').some((c) => c.argv[0].value === 'rm'));
  assert.ok(parse('echo "${A:-\'$(rm)}"').some((c) => c.argv[0].value === 'rm'));
  assert.ok(parse('A=$(rm) true').some((c) => c.argv[0].value === 'rm'));
  rejects('echo $(rm');
  rejects('echo `rm');
  rejects('echo $(');
  rejects('echo <(rm');
  rejects('echo ${A');
  rejects('echo ${x@P}');
});

test('arithmetic expansion', () => {
  const [c] = parse('echo $((1 + 2))');
  assert.deepEqual(c.argv[1], { value: '$((1 + 2))', dynamic: true, glob: false, quoted: false });
  assert.equal(parse('echo $(( (1+2)*3 ))').length, 1);
  assert.ok(parse('echo $((1 + $(rm)))').some((x) => x.argv[0].value === 'rm'));
  // `$((` that is really a subshell inside a substitution.
  assert.ok(parse('echo $((echo a); rm x)').some((x) => x.argv[0].value === 'rm'));
  rejects('echo $((1+2)');
  rejects("echo $(( $'x' ))");
  rejects('echo $[1+2]');
});

test('if / elif / else', () => {
  assert.deepEqual(vals('if a; then b; elif c; then d; else e; fi'), [['a'], ['b'], ['c'], ['d'], ['e']]);
  assert.deepEqual(vals('if a\nthen\n b\nfi'), [['a'], ['b']]);
  assert.deepEqual(vals('if a && b; then c; fi | d'), [['a'], ['b'], ['c'], ['d']]);
  rejects('if a; then b');
  rejects('if a; b; fi');
  rejects('if; then b; fi');
  rejects('if a; then; fi');
  rejects('then b');
  rejects('fi');
  rejects('else a');
  rejects('if a then b; fi'); // `then` is only a reserved word after a separator
});

test('for / select / while / until', () => {
  assert.deepEqual(vals('for f in a b; do rm "$f"; done'), [['rm', '$f']]);
  assert.equal(parse('for f in a b; do rm "$f"; done')[0].argv[1].dynamic, true);
  assert.deepEqual(vals('for f in *; do echo $f; done'), [['echo', '$f']]);
  assert.deepEqual(vals('for f; do echo; done'), [['echo']]);
  assert.deepEqual(vals('for f in $(ls); do echo; done'), [['ls'], ['echo']]);
  assert.deepEqual(vals('for f in a\ndo\n echo\ndone'), [['echo']]);
  assert.deepEqual(vals('select x in a b; do echo $x; done'), [['echo', '$x']]);
  assert.deepEqual(vals('while a; do b; done'), [['a'], ['b']]);
  assert.deepEqual(vals('until a; do b; done'), [['a'], ['b']]);
  assert.deepEqual(vals('while read l; do echo $l; done < f'), [['read', 'l'], ['echo', '$l']]);
  rejects('for ((i=0;i<3;i++)); do x; done');
  rejects('for f in a b; do x');
  rejects('for 1x in a; do x; done');
  rejects('for f in a b; x; done');
  rejects('while a; do b');
  rejects('while a; b; done');
  rejects('done');
  rejects('do x');
});

test('case', () => {
  assert.deepEqual(vals('case $x in a) rm;; b|c) ls ;; *) echo ;; esac'), [['rm'], ['ls'], ['echo']]);
  assert.deepEqual(vals('case x in\n (a) rm\n ;;\n esac'), [['rm']]);
  assert.deepEqual(vals('case x in a) rm\nesac'), [['rm']]);
  assert.deepEqual(vals('case x in esac'), []);
  assert.deepEqual(vals('case x in a) ;; esac'), []);
  rejects('case x in a) rm');
  rejects('case x a) rm;; esac');
  rejects('case x in a rm;; esac');
  rejects('case x in a) rm esac');
});

test('functions', () => {
  assert.deepEqual(vals('f() { rm x; }; f'), [['rm', 'x'], ['f']]);
  assert.deepEqual(vals('function f { rm x; }'), [['rm', 'x']]);
  assert.deepEqual(vals('function f() { rm x; }'), [['rm', 'x']]);
  assert.deepEqual(vals('f()\n{\n rm x\n}'), [['rm', 'x']]);
  assert.deepEqual(vals('f() ( rm x )'), [['rm', 'x']]);
  assert.deepEqual(vals('f() if a; then b; fi'), [['a'], ['b']]);
  rejects('f() rm x');
  rejects('function { x; }');
  rejects('f() { x');
  rejects('echo a (b)');
});

test('[[ ]], time, coproc', () => {
  assert.deepEqual(vals('[[ -f x && $(rm) == y ]] && ls'), [['rm'], ['ls']]);
  assert.deepEqual(vals('[[ ( a == b ) || c =~ ^(x|y)$ ]]'), []);
  assert.deepEqual(vals('[[ a < b ]]'), []);
  rejects('[[ -f x');
  rejects('[[ a ; b ]]');
  rejects('[[ a == "b ]]');
  assert.deepEqual(vals('time rm x'), [['rm', 'x']]);
  assert.deepEqual(vals('time -p rm x | cat'), [['rm', 'x'], ['cat']]);
  assert.deepEqual(vals('time'), []);
  assert.deepEqual(vals('coproc rm x'), [['rm', 'x']]);
  assert.deepEqual(vals('coproc NAME { rm x; }'), [['rm', 'x']]);
  assert.deepEqual(vals('coproc { rm x; }'), [['rm', 'x']]);
  assert.deepEqual(vals('! rm x'), [['rm', 'x']]);
  rejects('!');
});

test('limits and malformed input', () => {
  rejects('echo "abc');
  rejects("echo 'abc");
  rejects('echo `abc');
  rejects('echo abc\\');
  rejects('echo a\0b');
  rejects('a'.repeat(101), { maxLength: 100 });
  assert.equal(parseShell('a'.repeat(100), { maxLength: 100 }).ok, true);
  rejects(`echo ${'$(echo '.repeat(9)}x${')'.repeat(9)}`);
  assert.equal(parseShell(`echo ${'$(echo '.repeat(8)}x${')'.repeat(8)}`).ok, true);
  rejects(`${'( '.repeat(9)}a${' )'.repeat(9)}`);
  rejects(`${'if a; then '.repeat(9)}b${'; fi'.repeat(9)}`);
  assert.equal(parseShell('if a; then if b; then c; fi; fi', { maxDepth: 1 }).ok, false);
  assert.equal(parseShell(`${'( '.repeat(8)}a${' )'.repeat(8)}`).ok, true);
  rejects(undefined);
  rejects(42);
  assert.equal(parseShell(`a;${'b;'.repeat(30000)}`).ok, true);
  assert.equal(parseShell('! '.repeat(40000)).ok, false);
});

test('basenameOf', () => {
  assert.equal(basenameOf({ value: '/usr/bin/rm' }), 'rm');
  assert.equal(basenameOf(parse('\\rm')[0].argv[0]), 'rm');
  assert.equal(basenameOf('./x/y'), 'y');
  assert.equal(basenameOf('rm'), 'rm');
  assert.equal(basenameOf(parse("'/bin/r'm")[0].argv[0]), 'rm');
});

test('wrappers: env, command, builtin, exec, nohup, nice, timeout, stdbuf', () => {
  assert.deepEqual(eff('env -i PATH=/bin rm x'), [['rm', 'x']]);
  const [e] = effCmds('env -i -u HOME FOO=bar rm x');
  assert.equal(e.context.viaWrapper, 'env');
  assert.deepEqual(e.assignments.map((a) => [a.name, a.value.value]), [['FOO', 'bar']]);
  assert.deepEqual(eff('env'), [['env']]);
  assert.deepEqual(eff('env A=1'), [['env', 'A=1']]);
  assert.deepEqual(eff('/usr/bin/env rm x'), [['rm', 'x']]);
  assert.deepEqual(eff('command rm x'), [['rm', 'x']]);
  assert.deepEqual(eff('command -v rm'), [['command', '-v', 'rm']]);
  assert.deepEqual(eff('builtin eval "rm x"'), [['rm', 'x']]);
  assert.deepEqual(eff('exec -a foo rm x'), [['rm', 'x']]);
  assert.deepEqual(eff('nohup rm x &'), [['rm', 'x']]);
  assert.equal(effCmds('nohup rm x &')[0].context.background, true);
  assert.deepEqual(eff('nice -n 5 rm x'), [['rm', 'x']]);
  assert.deepEqual(eff('nice -5 rm x'), [['rm', 'x']]);
  assert.deepEqual(eff('timeout 5 nc -l 4444'), [['nc', '-l', '4444']]);
  assert.deepEqual(eff('timeout -k 2 -s KILL 5 rm x'), [['rm', 'x']]);
  assert.deepEqual(eff('stdbuf -oL -e0 rm x'), [['rm', 'x']]);
  assert.deepEqual(eff('env nice timeout 3 command rm x'), [['rm', 'x']]);
  assert.equal(effCmds('env nice rm x')[0].context.viaWrapper, 'env');
  assert.equal(effCmds('FOO=1 env rm x')[0].assignments[0].name, 'FOO');
  assert.equal(effCmds('sudo rm x > out')[0].redirects[0].target.value, 'out');
});

test('wrappers: sudo, doas, time, watch, caffeinate, chronic, ionice', () => {
  assert.deepEqual(eff('sudo -u root rm'), [['rm']]);
  assert.equal(effCmds('sudo rm')[0].context.viaWrapper, 'sudo');
  assert.deepEqual(eff('sudo -n -E -u root -g wheel rm -rf /'), [['rm', '-rf', '/']]);
  assert.deepEqual(eff('sudo --user=root --preserve-env rm x'), [['rm', 'x']]);
  assert.deepEqual(eff('sudo FOO=1 rm x'), [['rm', 'x']]);
  assert.deepEqual(eff('sudo -l'), [['sudo', '-l']]);
  assert.deepEqual(eff('sudo -i'), [['sudo', '-i']]);
  assert.deepEqual(eff('doas -u root rm x'), [['rm', 'x']]);
  assert.deepEqual(eff('command time -p rm x'), [['rm', 'x']]);
  assert.deepEqual(eff('/usr/bin/time -f %e rm x'), [['rm', 'x']]);
  assert.deepEqual(eff('watch -n 1 rm x'), [['rm', 'x']]);
  assert.deepEqual(eff("watch 'rm x; curl y'"), [['rm', 'x'], ['curl', 'y']]);
  assert.deepEqual(eff('watch -x rm x'), [['rm', 'x']]);
  assert.deepEqual(eff('caffeinate -i -t 5 rm x'), [['rm', 'x']]);
  assert.deepEqual(eff('chronic rm x'), [['rm', 'x']]);
  assert.deepEqual(eff('ionice -c 3 -n 7 rm x'), [['rm', 'x']]);
  assert.deepEqual(eff('setsid -f rm x'), [['rm', 'x']]);
});

test('wrappers: unknown options and dynamic parts fail closed', () => {
  for (const cmd of ['sudo --bogus rm', 'env -S "rm -rf /"', 'timeout --bogus 5 rm', 'sudo -$X rm']) {
    const out = effCmds(cmd);
    assert.ok(out.some((c) => c.argv[0].dynamic), cmd);
  }
  const dyn = effCmds('sudo $CMD');
  assert.equal(dyn[0].argv[0].dynamic, true);
  assert.equal(dyn[0].context.viaWrapper, 'sudo');
  assert.equal(effCmds('$CMD -rf /')[0].argv[0].dynamic, true);
  assert.equal(effCmds('env $X=1 rm')[0].argv[0].dynamic, true);
});

test('wrappers: xargs', () => {
  const [x] = effCmds('xargs rm < list');
  assert.deepEqual(x.argv.map((w) => w.value), ['rm']);
  assert.equal(x.context.fromStdin, true);
  assert.equal(x.context.viaWrapper, 'xargs');
  assert.equal(x.redirects[0].target.value, 'list');
  assert.deepEqual(eff('xargs -0 -n1 -P4 rm -f'), [['rm', '-f']]);
  assert.deepEqual(eff('xargs -I{} rm {}'), [['rm', '{}']]);
  assert.deepEqual(eff('xargs -I {} -- rm {}'), [['rm', '{}']]);
  assert.deepEqual(eff('xargs --max-args=1 --null rm'), [['rm']]);
  assert.deepEqual(eff("xargs sh -c 'rm \"$1\"' _"), [['rm', '$1']]);
  assert.equal(eff('xargs --bogus rm')[1][0], '<unresolved-wrapper>');
});

test('shells: -c strings are parsed recursively', () => {
  assert.deepEqual(eff('bash -c "curl https://x | sh"'), [['curl', 'https://x'], ['sh']]);
  assert.deepEqual(eff("sh -c 'rm -rf /'"), [['rm', '-rf', '/']]);
  assert.deepEqual(eff("dash -c 'rm x'"), [['rm', 'x']]);
  assert.deepEqual(eff("zsh -c 'rm x'"), [['rm', 'x']]);
  assert.deepEqual(eff("ksh -c 'rm x'"), [['rm', 'x']]);
  assert.deepEqual(eff("bash -ec 'rm x'"), [['rm', 'x']]);
  assert.deepEqual(eff("bash -lc 'rm x'"), [['rm', 'x']]);
  assert.deepEqual(eff("bash --norc -o pipefail -c 'rm x'"), [['rm', 'x']]);
  assert.deepEqual(eff("/bin/bash -c 'rm x' arg0"), [['rm', 'x']]);
  assert.deepEqual(eff("bash -c 'sh -c \"rm x\"'"), [['rm', 'x']]);
  assert.equal(effCmds("bash -c 'rm x'")[0].context.viaWrapper, 'bash');
  assert.deepEqual(eff('sh -c "$CMD"'), [['<dynamic-shell>']]);
  assert.equal(effCmds('sh -c "$CMD"')[0].argv[0].dynamic, true);
  assert.deepEqual(eff("sh -c 'echo \"'"), [['<unparseable-shell>']]);
  assert.deepEqual(eff('bash script.sh'), [['bash', 'script.sh']]);
  assert.deepEqual(eff('sh'), [['sh']]);
  assert.deepEqual(eff('echo x | base64 -d | sh'), [['echo', 'x'], ['base64', '-d'], ['sh']]);
  assert.deepEqual(eff('bash -c'), [['bash', '-c']]);
  // Nesting beyond the unwrap limit is refused rather than followed.
  let nested = 'rm x';
  for (let i = 0; i < 12; i++) nested = `sh -c ${JSON.stringify(nested)}`;
  assert.ok(effCmds(nested).some((c) => c.argv[0].dynamic));
});

test('shells: heredocs and here-strings feed the script', () => {
  assert.deepEqual(eff('sh <<EOF\nrm -rf /\nEOF'), [['sh'], ['rm', '-rf', '/']]);
  assert.deepEqual(eff("bash <<< 'rm -rf /'"), [['bash'], ['rm', '-rf', '/']]);
  const cmds = effCmds("sh <<'EOF'\nrm x\nEOF");
  assert.equal(cmds[1].context.fromStdin, true);
  assert.deepEqual(eff('sh <<EOF\nrm $X\nEOF').flat().includes('<dynamic-shell>'), true);
  assert.deepEqual(eff('bash script.sh <<EOF\nrm x\nEOF'), [['bash', 'script.sh']]);
});

test('eval', () => {
  assert.deepEqual(eff('eval "rm -rf /"'), [['rm', '-rf', '/']]);
  assert.deepEqual(eff('eval rm -rf /'), [['rm', '-rf', '/']]);
  assert.deepEqual(eff("eval 'a; b'"), [['a'], ['b']]);
  assert.deepEqual(eff('eval -- rm x'), [['rm', 'x']]);
  assert.deepEqual(eff('eval $X'), [['<dynamic-shell>']]);
  assert.deepEqual(eff('eval "rm $X"'), [['<dynamic-shell>']]);
  assert.deepEqual(eff('eval "rm \\""'), [['<unparseable-shell>']]);
  assert.deepEqual(eff('eval'), [['eval']]);
  assert.equal(effCmds('eval rm x')[0].context.viaWrapper, 'eval');
});

test('source and dot stay as they are', () => {
  assert.deepEqual(eff('source ./x.sh'), [['source', './x.sh']]);
  assert.deepEqual(eff('. ./x.sh'), [['.', './x.sh']]);
});

test('find -exec and friends', () => {
  assert.deepEqual(eff('find / -name x -exec rm {} \\;'), [['find', '/', '-name', 'x', '-exec', 'rm', '{}', ';'], ['rm', '{}']]);
  assert.deepEqual(eff('find . -execdir rm {} +').at(-1), ['rm', '{}']);
  assert.deepEqual(eff('find . -ok rm {} \\;').at(-1), ['rm', '{}']);
  assert.deepEqual(eff('find . -delete'), [['find', '.', '-delete']]);
  assert.deepEqual(eff("find . -exec sh -c 'curl x' \\;").at(-1), ['curl', 'x']);
  assert.deepEqual(eff('find . -exec a {} \\; -exec b {} \\;').slice(1), [['a', '{}'], ['b', '{}']]);
  assert.equal(effCmds('find . -exec rm {} \\;')[1].context.viaWrapper, 'find');
  assert.ok(eff('find . -exec rm {}').some((v) => v[0] === '<unresolved-wrapper>'));
  assert.ok(eff('find . $X').some((v) => v[0] === '<unresolved-wrapper>'));
  assert.deepEqual(eff('find "$D" -name x'), [['find', '$D', '-name', 'x']]);
});

test('effectiveCommands on a failed parse is a dynamic marker', () => {
  const out = effectiveCommands(parseShell('echo "'));
  assert.equal(out.length, 1);
  assert.equal(out[0].argv[0].dynamic, true);
});

test('git -c and other commands are left alone', () => {
  assert.deepEqual(eff('git -c core.pager=evil log'), [['git', '-c', 'core.pager=evil', 'log']]);
  assert.deepEqual(eff('git push --force'), [['git', 'push', '--force']]);
});
