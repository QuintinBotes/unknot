// Known defects planted into a copy of a repository, so recall can be measured against
// ground truth that is certain: an import cycle between two new files, a private function
// nobody calls, a function far over the length limit and (C#, Java) a constructor-injected
// member that is never used. Every file lives under SEED_DIR.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SEED_DIR = 'unknot_seed';

export const SEED_KINDS = Object.freeze({
  cycle: 'module.dependency-cycle',
  'dead-function': 'code.dead-code',
  'long-function': 'code.long-function',
  'unused-injected-member': 'code.unused-injected-member',
});

export const SEEDED_LANGUAGES = ['csharp', 'java', 'python', 'ruby', 'php', 'go', 'typescript'];

const safeDirs = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e) => e.name).sort();
  } catch {
    return [];
  }
};
const body = (n, line) => Array.from({ length: n }, (_, i) => line(i)).join('\n');
const LONG = 110;

const seeds = {
  python: () => ({
    [`${SEED_DIR}/__init__.py`]: '',
    [`${SEED_DIR}/cycle_a.py`]: 'from unknot_seed.cycle_b import b_value\n\n\ndef a_value():\n    return b_value()\n',
    [`${SEED_DIR}/cycle_b.py`]: 'from unknot_seed.cycle_a import a_value\n\n\ndef b_value():\n    return a_value()\n',
    [`${SEED_DIR}/dead.py`]: 'def _seed_unused_helper_zq(x):\n    return x * 2\n\n\ndef seed_public_entry():\n    return 1\n',
    [`${SEED_DIR}/long.py`]: `def seed_long_function_zq(total):\n${body(LONG, (i) => `    total = total + ${i}`)}\n    return total\n`,
  }),
  typescript: () => ({
    [`${SEED_DIR}/cycleA.ts`]: "import { bValue } from './cycleB';\nexport const aValue = (): number => bValue();\n",
    [`${SEED_DIR}/cycleB.ts`]: "import { aValue } from './cycleA';\nexport const bValue = (): number => aValue();\n",
    [`${SEED_DIR}/dead.ts`]: 'function seedUnusedHelperZq(x: number): number {\n  return x * 2;\n}\nexport const seedPublicEntry = (): number => 1;\n',
    [`${SEED_DIR}/long.ts`]: `export function seedLongFunctionZq(total: number): number {\n${body(LONG, (i) => `  total = total + ${i};`)}\n  return total;\n}\n`,
  }),
  go: (root) => {
    // Seed inside the first Go module found: the repository root, else a directory one or two levels down.
    const candidates = ['', ...safeDirs(root).flatMap((d) => [d, ...safeDirs(join(root, d)).map((e) => `${d}/${e}`)])];
    const base = candidates.find((d) => existsSync(join(root, d, 'go.mod'))) ?? '';
    const mod = /^module\s+(\S+)/m.exec(existsSync(join(root, base, 'go.mod')) ? readFileSync(join(root, base, 'go.mod'), 'utf8') : '')?.[1] ?? 'seed.example/module';
    const at = (p) => (base ? `${base}/${p}` : p);
    return {
      [at(`${SEED_DIR}/cyclea/a.go`)]: `package cyclea\n\nimport "${mod}/${SEED_DIR}/cycleb"\n\nfunc AValue() int { return cycleb.BValue() }\n`,
      [at(`${SEED_DIR}/cycleb/b.go`)]: `package cycleb\n\nimport "${mod}/${SEED_DIR}/cyclea"\n\nfunc BValue() int { return cyclea.AValue() }\n`,
      [at(`${SEED_DIR}/misc/dead.go`)]: 'package misc\n\nfunc seedUnusedHelperZq(x int) int {\n\treturn x * 2\n}\n\nfunc SeedPublicEntry() int { return 1 }\n',
      [at(`${SEED_DIR}/misc/long.go`)]: `package misc\n\nfunc SeedLongFunctionZq(total int) int {\n${body(LONG, (i) => `\ttotal = total + ${i}`)}\n\treturn total\n}\n`,
    };
  },
  java: () => ({
    [`${SEED_DIR}/CycleA.java`]: 'package unknot.seed;\n\nimport unknot.seed.CycleB;\n\npublic class CycleA {\n    public int value() {\n        return new CycleB().value();\n    }\n}\n',
    [`${SEED_DIR}/CycleB.java`]: 'package unknot.seed;\n\nimport unknot.seed.CycleA;\n\npublic class CycleB {\n    public int value() {\n        return new CycleA().value();\n    }\n}\n',
    [`${SEED_DIR}/Dead.java`]: 'package unknot.seed;\n\npublic class Dead {\n    private int seedUnusedHelperZq(int x) {\n        return x * 2;\n    }\n\n    public int entry() {\n        return 1;\n    }\n}\n',
    [`${SEED_DIR}/Long.java`]: `package unknot.seed;\n\npublic class Long {\n    public int seedLongFunctionZq(int total) {\n${body(LONG, (i) => `        total = total + ${i};`)}\n        return total;\n    }\n}\n`,
    [`${SEED_DIR}/SeedService.java`]: 'package unknot.seed;\n\npublic interface SeedService {\n    int run();\n}\n',
    [`${SEED_DIR}/Consumer.java`]: 'package unknot.seed;\n\npublic class Consumer {\n    private final SeedService service;\n\n    public Consumer(SeedService service) {\n        this.service = service;\n    }\n\n    public int entry() {\n        return 1;\n    }\n}\n',
  }),
  csharp: () => ({
    [`${SEED_DIR}/CycleA.cs`]: 'namespace Unknot.Seed.A\n{\n    public class CycleA\n    {\n        public int Value() => new Unknot.Seed.B.CycleB().Value();\n    }\n}\n',
    [`${SEED_DIR}/CycleB.cs`]: 'namespace Unknot.Seed.B\n{\n    public class CycleB\n    {\n        public int Value() => new Unknot.Seed.A.CycleA().Value();\n    }\n}\n',
    [`${SEED_DIR}/Dead.cs`]: 'namespace Unknot.Seed\n{\n    public class Dead\n    {\n        private int SeedUnusedHelperZq(int x)\n        {\n            return x * 2;\n        }\n\n        public int Entry() => 1;\n    }\n}\n',
    [`${SEED_DIR}/Long.cs`]: `namespace Unknot.Seed\n{\n    public class Long\n    {\n        public int SeedLongFunctionZq(int total)\n        {\n${body(LONG, (i) => `            total = total + ${i};`)}\n            return total;\n        }\n    }\n}\n`,
    [`${SEED_DIR}/ISeedService.cs`]: 'namespace Unknot.Seed\n{\n    public interface ISeedService\n    {\n        int Run();\n    }\n}\n',
    [`${SEED_DIR}/Consumer.cs`]: 'namespace Unknot.Seed\n{\n    public class Consumer\n    {\n        private readonly ISeedService _service;\n\n        public Consumer(ISeedService service)\n        {\n            _service = service;\n        }\n\n        public int Entry() => 1;\n    }\n}\n',
  }),
  ruby: () => ({
    [`${SEED_DIR}/cycle_a.rb`]: "require_relative 'cycle_b'\n\nmodule UnknotSeed\n  class CycleA\n    def value\n      CycleB.new.value\n    end\n  end\nend\n",
    [`${SEED_DIR}/cycle_b.rb`]: "require_relative 'cycle_a'\n\nmodule UnknotSeed\n  class CycleB\n    def value\n      CycleA.new.value\n    end\n  end\nend\n",
    [`${SEED_DIR}/dead.rb`]: 'module UnknotSeed\n  class Dead\n    def entry\n      1\n    end\n\n    private\n\n    def seed_unused_helper_zq(x)\n      x * 2\n    end\n  end\nend\n',
    [`${SEED_DIR}/long.rb`]: `module UnknotSeed\n  class Long\n    def seed_long_function_zq(total)\n${body(LONG, (i) => `      total = total + ${i}`)}\n      total\n    end\n  end\nend\n`,
  }),
  php: () => ({
    [`${SEED_DIR}/CycleA.php`]: '<?php\n\nnamespace UnknotSeed;\n\nuse UnknotSeed\\CycleB;\n\nclass CycleA\n{\n    public function value(): int\n    {\n        return (new CycleB())->value();\n    }\n}\n',
    [`${SEED_DIR}/CycleB.php`]: '<?php\n\nnamespace UnknotSeed;\n\nuse UnknotSeed\\CycleA;\n\nclass CycleB\n{\n    public function value(): int\n    {\n        return (new CycleA())->value();\n    }\n}\n',
    [`${SEED_DIR}/Dead.php`]: '<?php\n\nnamespace UnknotSeed;\n\nclass Dead\n{\n    private function seedUnusedHelperZq(int $x): int\n    {\n        return $x * 2;\n    }\n\n    public function entry(): int\n    {\n        return 1;\n    }\n}\n',
    [`${SEED_DIR}/Long.php`]: `<?php\n\nnamespace UnknotSeed;\n\nclass Long\n{\n    public function seedLongFunctionZq(int $total): int\n    {\n${body(LONG, (i) => `        $total = $total + ${i};`)}\n        return $total;\n    }\n}\n`,
  }),
};

/** The defects to plant for a language: files plus what must be found, as [seed, kind, path]. */
export function seedsFor(language, root) {
  const make = seeds[language];
  if (!make) return null;
  const files = make(root);
  const has = (re) => Object.keys(files).filter((p) => re.test(p));
  const expect = [];
  const cyc = has(/cycle/i);
  if (cyc.length) expect.push({ seed: 'cycle', kind: SEED_KINDS.cycle, paths: cyc });
  const dead = has(/dead/i);
  if (dead.length) expect.push({ seed: 'dead-function', kind: SEED_KINDS['dead-function'], paths: dead });
  const long = has(/long/i);
  if (long.length) expect.push({ seed: 'long-function', kind: SEED_KINDS['long-function'], paths: long });
  const inj = has(/consumer/i);
  if (inj.length) expect.push({ seed: 'unused-injected-member', kind: SEED_KINDS['unused-injected-member'], paths: inj });
  return { files, expect };
}
