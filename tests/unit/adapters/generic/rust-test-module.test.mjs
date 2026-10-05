import { test } from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../../../../adapters/language/generic/index.mjs';

test('rust: #[cfg(test)] modules are excluded from sloc and counted as test_sloc', () => {
  const src = [
    'pub fn real() -> i32 {', '    1', '}', '',
    '#[cfg(test)]', 'mod tests {', '    use super::*;', '    #[test]', '    fn t() {', '        assert_eq!(real(), 1);', '    }', '}', '',
    'pub fn after() {}', '',
  ].join('\n');
  const facts = adapter.extract({ path: 'src/lib.rs' }, src, {});
  const m = facts.find((f) => f.kind === 'node' && f.type === 'module');
  assert.equal(m.attrs.sloc, 4);
  assert.equal(m.attrs.test_sloc, 8);
});

test('non-rust files carry no test_sloc', () => {
  const m = adapter.extract({ path: 'A.java' }, 'class A {\n}\n', {}).find((f) => f.kind === 'node' && f.type === 'module');
  assert.equal(m.attrs.test_sloc, undefined);
});
