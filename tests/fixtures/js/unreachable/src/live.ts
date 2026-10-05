export function arms(x: number): string {
  switch (x) {
    case 1:
      return 'one';
    case 2:
      return 'two';
    default:
      return 'many';
  }
}

export function guard(x: number): number {
  if (x) return 1;
  doMore();
  return 2;
}

export function nested(x: number): number {
  if (x) {
    return 1;
  }
  const y = x + 1;
  return y;
}

export function hoisted(): number {
  return helper();

  function helper(): number {
    return 1;
  }
  class Local {}
}

export function typesAfter(): number {
  return 1;
  type Later = string;
  interface Shape { a: number }
}

export function tryNoCatch(): number {
  try {
    return risky();
  } catch (e) {
    log(e);
  }
  return 0;
}

export function callbacks(list: number[]): number[] {
  return list.map((v) => {
    if (v) return 1;
    return 2;
  });
}

declare function doMore(): void;
declare function risky(): number;
declare function log(e: unknown): void;
