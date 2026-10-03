const x = 1;
const t1 = `outer ${`inner ${`deep ${x}`}`} end`;
const t2 = `obj ${JSON.stringify({ k: `v${x}`, brace: '}' })} done`;
const t3 = `multi
line ${x > 0 ? `pos` : `neg`}
text`;

function sentinel(a) {
  if (a) {
    return `${a}`;
  }
  return 0;
}
