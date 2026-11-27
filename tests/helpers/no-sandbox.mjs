// Makes detectSandbox() find no OS sandbox, the way a platform without one looks (#148).
// Preload it into the CLI (`node --import ./tests/helpers/no-sandbox.mjs bin/unknot ...`) or
// call hide()/restore() around an in-process test. Only the test suite uses this; the runtime
// has no switch of its own that turns the sandbox off.

const real = Object.getOwnPropertyDescriptor(process, 'platform');

export function hide() {
  Object.defineProperty(process, 'platform', { ...real, value: 'freebsd' });
}

export function restore() {
  Object.defineProperty(process, 'platform', real);
}

if (process.env.UNKNOT_TEST_HIDE_SANDBOX === '1') hide();
