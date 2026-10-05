// Essential complexity: see docs/adr/0001-expression-parser.md
export function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < src.length && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j += 1;
      tokens.push({ type: 'num', value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      if (end === -1) throw new Error('unterminated string');
      tokens.push({ type: 'str', value: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch });
      i += 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    switch (two.length === 2 && ['==', '!=', '<=', '>=', '&&', '||'].includes(two) ? two : ch) {
      case '+':
        tokens.push({ type: 'op', value: '+' });
        i += 1;
        break;
      case '-':
        tokens.push({ type: 'op', value: '-' });
        i += 1;
        break;
      case '*':
        tokens.push({ type: 'op', value: '*' });
        i += 1;
        break;
      case '/':
        tokens.push({ type: 'op', value: '/' });
        i += 1;
        break;
      case '%':
        tokens.push({ type: 'op', value: '%' });
        i += 1;
        break;
      case '^':
        tokens.push({ type: 'op', value: '^' });
        i += 1;
        break;
      case '==':
        tokens.push({ type: 'op', value: '==' });
        i += 2;
        break;
      case '!=':
        tokens.push({ type: 'op', value: '!=' });
        i += 2;
        break;
      case '<':
        tokens.push({ type: 'op', value: '<' });
        i += 1;
        break;
      case '>':
        tokens.push({ type: 'op', value: '>' });
        i += 1;
        break;
      case '<=':
        tokens.push({ type: 'op', value: '<=' });
        i += 2;
        break;
      case '>=':
        tokens.push({ type: 'op', value: '>=' });
        i += 2;
        break;
      case '&&':
        tokens.push({ type: 'op', value: '&&' });
        i += 2;
        break;
      case '||':
        tokens.push({ type: 'op', value: '||' });
        i += 2;
        break;
      default:
        throw new Error('unexpected character ' + ch);
    }
  }
  return tokens;
}
