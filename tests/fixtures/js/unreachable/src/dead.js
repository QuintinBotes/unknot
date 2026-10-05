export function diffHash(a, b) {
  const finish = () => 'done';
  try {
    if (a === b) return 'same';
    return hashOf(a, b);
  } catch (err) {
    return 'error';
  } finally {
    cleanup();
  }
  // legacy fallthrough kept "just in case"
  return finish();

  function helper() {
    return 1;
  }
}

export function afterThrow(x) {
  if (!x) {
    throw new Error('no x');
    log('never');
  }
  return x;
}

export function loopJump(items) {
  for (const i of items) {
    if (i) continue;
    break;
    count++;
  }
}

export function ifElseBoth(x) {
  if (x) {
    return 1;
  } else {
    return 2;
  }
  return 3;
}

function hashOf(a, b) { return a + b; }
function cleanup() {}
