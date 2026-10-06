// Per-language syntax tables for the member engine (members.mjs). One mechanism reads every
// table; a language is a few regular expressions, not code. A table says:
//
//   blank        text to hide before types are looked for (imports, `using`, `package`)
//   nameof       a construct that names a symbol without using it (hidden when checking use)
//   heads        a type name as it is mentioned (group 1; chains like `A.B` for dotted languages)
//   forms        how a mention of a type declares something, tried in order. `before` and `after`
//                are matched against the text on either side of the type name (`before` anchored
//                at its end); a named group `name` is the declared name, `mods` the modifiers.
//                kind: `member` (field/property), `param`, or `both` (a constructor parameter
//                that is also a member). `gate` lists patterns of which one must match `before`:
//                a member is considered only when it is private or injected, so a public
//                contract member never counts as unused. `pubTail` and `pubName` say when the
//                member can be reached from other files (null: always); `weak` names the members
//                whose reach is by convention only (labelled `weakLabel` rather than public)
//   inject       a statement that stores a parameter into a member where there is no member
//                declaration (`self.x = x`): groups `l` (member) and `r` (parameter)
//   ctorAssign   the statement that stores a parameter into a member (groups 1 and 2); it is
//                neither a read of the member nor a use of the parameter
//   self         the names of the current instance; `selfDecl` finds receiver names (Go)
//   bare         whether a bare `x` inside a class reads the member `x` (C#, Java, Kotlin)
//   typed        how a local, parameter or field states its type: [{ re, type, name }]
//   infer        `var x = new T(...)` and the like: [{ re, name, rhs, rhsTypes }]
//   untyped      declarations that state no type (lambda parameters): [{ re, names }]
//   news         `new T`: group 1 is the type; init: `new T { Member = ... }` or `T{member: ...}`
//   notName      words that look like a declared name and are not
//   chain        receiver words that end a chain of declared types (`base`, `super`)
//   strip        what to ignore at the end of a receiver (`!` in TypeScript)
//
// The regexes here are the whole language knowledge of the unused-member analysis.

const MODS_CS = '(?:(?:public|private|protected|internal|static|readonly|virtual|override|required|new|sealed|volatile|abstract|partial|unsafe)\\s+)';
const BUILTIN_CS = 'string|int|long|short|byte|bool|char|decimal|double|float|object|uint|ulong|ushort|sbyte|nint|nuint';
const BUILTIN_JAVA = 'int|long|short|byte|boolean|char|double|float';

const GUARD_CS = '(?:\\s*\\?\\?\\s*throw\\s+new\\s+[\\w.]+\\s*\\([^;]*\\))?';

const typedC = (builtin) => new RegExp(`(?<![\\w.@$])(${builtin}|[A-Z]\\w*(?:\\s*\\.\\s*[A-Z]\\w*)*)(?:\\s*<[^;(){}=]*?>)?\\??(?:\\s*\\[[,\\s]*\\])*\\s+@?([A-Za-z_]\\w*)\\s*(?=[=;,):]|\\?(?![?.])|&&|\\|\\||=>|\\b(?:in|when|and|or)\\b|\\{\\s*(?:\\[[^\\]]*\\]\\s*)*(?:get|set|init)\\b)`, 'g');

const MODS_JAVA = '(?:(?:public|private|protected|static|final|volatile|transient)\\s+)';
const JAVA_DI = '(?:Autowired|Inject|Resource|EJB|PersistenceContext|MockBean|InjectMocks|Mock|Value)';
const DOTTED = '[A-Z]\\w*(?:\\s*\\.\\s*[A-Z]\\w*)*';

const ARROW_NAMES = (arrow) => ({ re: new RegExp(`\\(\\s*([A-Za-z_$][\\w$]*(?:\\s*,\\s*[A-Za-z_$][\\w$]*)*)\\s*\\)\\s*${arrow}`, 'g'), names: 1 });

const TS_MODS = '(?:public|private|protected|readonly|static|declare|override|abstract)';
const TS_DI = '@(?:Inject|InjectRepository|InjectModel|InjectConnection|InjectDataSource|Input)\\b';
const TS_AFTER = '(?:\\s*<[^;(){}=]*>)?(?:\\s*\\|\\s*(?:null|undefined))?';

const PY_AFTER = '(?:\\s*\\[[^\\]\\n]*\\])?(?:\\s*\\|\\s*None)?\\s*\\]?';

export const MEMBER_SYNTAX = {
  csharp: {
    lang: 'csharp',
    blank: /^[ \t]*(?:global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?[\w.]+\s*;|\bnamespace\s+[\w.]+/gm,
    nameof: /\bnameof\s*\(\s*[\w.]+\s*\)/g,
    nameofBefore: /\bnameof\s*\(\s*(?:[\w]+\s*\.\s*)*$/,
    heads: /(?<![\w.@$])([A-Z]\w*(?:\s*\.\s*[A-Z]\w*)*)/g,
    forms: [
      {
        kind: 'member',
        gate: [
          new RegExp(`\\[[^\\]]*\\b(?:Dependency|Inject|FromServices|Import|ImportMany|Autowired)\\b[^\\]]*\\]\\s*(?:\\[[^\\]]*\\]\\s*)*${MODS_CS}*$`),
          new RegExp(`(?:^|[;{}\\]])\\s*(?=${MODS_CS}*\\b(?:private|readonly)\\b)(?!${MODS_CS}*\\b(?:public|protected|internal)\\b)${MODS_CS}+$`),
        ],
        tail: new RegExp(`(${MODS_CS}*)$`),
        pubTail: /\b(?:public|protected|internal)\b/,
        after: /^(?:\s*<[^;{}()=]*>)?\??\s+(?<name>[A-Za-z_]\w*)\s*(\{\s*(?:\[[^\]]*\]\s*)*(?:get|set|init)\b|;|=(?![=>]))/,
      },
      {
        kind: 'param',
        before: /[(,]\s*(?:(?:this|ref|in|out|params|readonly)\s+)*$/,
        after: /^(?:\s*<[^;{}()=]*>)?\??\s+(?<name>[A-Za-z_]\w*)\s*(?=[,)]|=\s*(?:null|default)\s*[,)])/,
      },
    ],
    ctorAssign: new RegExp(`(?:\\bthis\\s*\\.\\s*)?\\b(\\w+)\\s*=\\s*(\\w+)${GUARD_CS}\\s*;`, 'g'),
    self: ['this'],
    bare: true,
    typed: [{ re: typedC(BUILTIN_CS), type: 1, name: 2 }],
    infer: [{
      re: /\bvar\s+@?(\w+)(\s*=\s*[^;]*)?/g,
      name: 1,
      rhs: 2,
      rhsTypes: [/^\s*=\s*new\s+([A-Z][\w.]*)/, /^\s*=\s*\(\s*([A-Z][\w.]*)(?:<[^()]*>)?\s*\)\s*[\w(]/, /\bas\s+([A-Z][\w.]*)/],
    }],
    untyped: [{ re: /\b([A-Za-z_]\w*)\s*=>/g, names: 1 }, ARROW_NAMES('=>')],
    news: /\bnew\s+([A-Z][\w.]*)/g,
    init: { re: /\bnew\s+([A-Z][\w.]*)(?:\s*<[^;(){}=]*?>)?\s*(?:\([^()]*\))?\s*\{/g, key: /^\s*([A-Za-z_]\w*)\s*=(?![=>])/ },
    notName: ['in', 'is', 'as', 'when', 'and', 'or', 'new', 'return', 'await', 'out', 'ref'],
    chain: /^(?:base|typeof|nameof)$/,
  },

  java: {
    lang: 'java',
    blank: /^[ \t]*(?:package|import(?:\s+static)?)\s+[\w.*]+\s*;/gm,
    heads: /(?<![\w.@$])([A-Z]\w*(?:\s*\.\s*[A-Z]\w*)*)/g,
    forms: [
      {
        kind: 'member',
        gate: [
          new RegExp(`@${JAVA_DI}\\b(?:\\([^)]*\\))?\\s*(?:@[\\w.]+(?:\\([^)]*\\))?\\s*)*${MODS_JAVA}*$`),
          new RegExp(`(?:^|[;{}\\)]|@[\\w.]+)\\s*(?=${MODS_JAVA}*\\bprivate\\b)(?!${MODS_JAVA}*\\b(?:public|protected)\\b)${MODS_JAVA}+$`),
        ],
        tail: new RegExp(`(${MODS_JAVA}*)$`),
        pubTail: /^(?![\s\S]*\bprivate\b)/,
        after: /^(?:\s*<[^;{}()=]*>)?(?:\s*\[\s*\])*\s+(?<name>[A-Za-z_]\w*)\s*(?:;|=(?![=>]))/,
      },
      {
        kind: 'param',
        before: /[(,]\s*(?:(?:final)\s+|@[\w.]+(?:\([^)]*\))?\s+)*$/,
        after: /^(?:\s*<[^;{}()=]*>)?(?:\s*\[\s*\])*(?:\s*\.\.\.)?\s+(?<name>[A-Za-z_]\w*)\s*(?=[,)])/,
      },
    ],
    ctorAssign: /(?:\bthis\s*\.\s*)?\b(\w+)\s*=\s*(?:(?:Objects\s*\.\s*)?requireNonNull\s*\(\s*)?(\w+)(?:\s*,\s*[^;()]*)?\)?\s*;/g,
    self: ['this'],
    bare: true,
    typed: [{ re: typedC(BUILTIN_JAVA), type: 1, name: 2 }],
    infer: [{
      re: /\bvar\s+(\w+)(\s*=\s*[^;]*)?/g,
      name: 1,
      rhs: 2,
      rhsTypes: [/^\s*=\s*new\s+([A-Z][\w.]*)/, /^\s*=\s*\(\s*([A-Z][\w.]*)(?:<[^()]*>)?\s*\)\s*[\w(]/],
    }],
    untyped: [{ re: /\b([A-Za-z_]\w*)\s*->/g, names: 1 }, ARROW_NAMES('->')],
    news: /\bnew\s+([A-Z][\w.]*)/g,
    notName: ['instanceof', 'return', 'new', 'else', 'case', 'throw', 'final'],
    chain: /^(?:super|class)$/,
    loose: [],
  },

  kotlin: {
    lang: 'kotlin',
    blank: /^[ \t]*(?:package|import)\s+[\w.*]+(?:\s+as\s+\w+)?[ \t]*$/gm,
    heads: /(?<![\w.@$])([A-Z]\w*(?:\s*\.\s*[A-Z]\w*)*)/g,
    forms: (() => {
      const mods = '(?<mods>(?:@[\\w.:]+(?:\\([^)]*\\))?\\s+|(?:public|private|protected|internal|lateinit|override|open|final|const|abstract)\\s+)*)';
      const after = '^(?:\\s*<[^;{}()=]*>)?\\??(?=[ \\t]*(?:[,)=;\\n]|$|by\\b))';
      const gate = [
        /\bprivate\s+(?:(?:lateinit|override|final|open)\s+)*(?:val|var)\s+\w+\s*:\s*$/,
        /@(?:field:|param:|set:)?(?:Inject|Autowired|Resource|Value)\b(?:\([^)]*\))?\s+(?:[\w@.:()]+\s+)*(?:val|var)\s+\w+\s*:\s*$/,
      ];
      const pubTail = /^(?![\s\S]*\bprivate\b)/;
      return [
        { kind: 'both', before: new RegExp(`[(,]\\s*${mods}(?:val|var)\\s+(?<name>[A-Za-z_]\\w*)\\s*:\\s*$`), after: new RegExp(after), gate, pubTail },
        { kind: 'member', before: new RegExp(`(?:^|[;{}\\n])\\s*${mods}(?:val|var)\\s+(?<name>[A-Za-z_]\\w*)\\s*:\\s*$`), after: new RegExp(after), gate, pubTail },
        { kind: 'param', before: /[(,]\s*(?:(?:vararg|noinline|crossinline)\s+)?(?<name>[A-Za-z_]\w*)\s*:\s*$/, after: /^(?:\s*<[^;{}()=]*>)?\??(?=\s*[,)=])/ },
      ];
    })(),
    ctorAssign: /(?:\bthis\s*\.\s*)?\b(\w+)\s*=\s*(\w+)(?=[ \t]*(?:;|\n|$))/g,
    self: ['this'],
    bare: true,
    typed: [
      { re: new RegExp(`(?<![\\w.])([A-Za-z_]\\w*)\\s*:\\s*(${DOTTED})(?:\\s*<[^;(){}=]*?>)?\\??(?=[\\s,;)=}{]|$)`, 'g'), type: 2, name: 1 },
      { re: new RegExp(`\\b(\\w+)\\s+is\\s+(${DOTTED})`, 'g'), type: 2, name: 1 },
    ],
    infer: [{
      re: /\b(?:val|var)\s+(\w+)(\s*=\s*[^\n;]*)?/g,
      name: 1,
      rhs: 2,
      rhsTypes: [/^\s*=\s*([A-Z][\w.]*)\s*[({<]/, /\bas\??\s+([A-Z][\w.]*)/],
    }],
    untyped: [{ re: /[{(,]\s*(\w+(?:\s*,\s*\w+)*)\s*->/g, names: 1 }],
    notName: ['is', 'as', 'in', 'return', 'val', 'var', 'when'],
    chain: /^(?:super)$/,
    loose: [],
    quoted: /["']([A-Za-z_]\w*)["']/g,
  },

  typescript: {
    lang: 'typescript',
    blank: /^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom\s*['"][^'"]*['"][ \t]*;?|^[ \t]*import\s*['"][^'"]*['"][ \t]*;?|^[ \t]*import\s+\w+\s*=\s*require\([^)]*\)[ \t]*;?/gm,
    heads: /(?<![\w.@$])([A-Z][\w$]*(?:\s*\.\s*[A-Z][\w$]*)*)/g,
    forms: (() => {
      const deco = '(?:@[\\w.]+(?:\\([^)]*\\))?\\s*)*';
      const after = new RegExp(`^${TS_AFTER}(?=\\s*[,)=])`);
      const fieldAfter = new RegExp(`^${TS_AFTER}(?=[ \\t]*(?:[;=,}]|\\n|$))`);
      const priv = /\bprivate\s+(?:(?:readonly|static|override|declare|abstract)\s+)*[\w$]+[!?]?\s*:\s*$/;
      const hash = /(?:^|[\s;{}(,])#[\w$]+[!?]?\s*:\s*$/;
      const di = new RegExp(`${TS_DI}[^;{}]*$`);
      const pubTail = /^(?![\s\S]*\bprivate\b)/;
      return [
        { kind: 'both', before: new RegExp(`(?:^|[(,])\\s*${deco}(?<mods>(?:${TS_MODS}\\s+)+)(?<name>[A-Za-z_$][\\w$]*)\\??\\s*:\\s*$`), after, gate: [priv, di], pubTail },
        { kind: 'param', before: new RegExp(`[(,]\\s*${deco}(?<name>[A-Za-z_$][\\w$]*)\\??\\s*:\\s*$`), after },
        { kind: 'member', before: new RegExp(`(?:^|[;{}\\n])\\s*${deco}(?<mods>(?:${TS_MODS}\\s+)*)(?<name>#?[A-Za-z_$][\\w$]*)[!?]?\\s*:\\s*$`), after: fieldAfter, gate: [priv, hash, di], pubTail, pubName: /^[^#]/ },
      ];
    })(),
    ctorAssign: /\bthis\s*\.\s*(\w+)\s*=\s*(\w+)\s*(?:;|$)/gm,
    self: ['this'],
    bare: false,
    typed: [{
      re: new RegExp(`(?:^|[(,;{\\n])[ \\t]*(?:(?:${TS_MODS}|const|let|var)\\s+)*(?:\\.\\.\\.)?([A-Za-z_$][\\w$]*)[!?]?\\s*:\\s*(${DOTTED.replace(/\\w/g, '[\\w$]')})(?:\\s*<[^;(){}=]*?>)?(?=\\s*(?:[,;)=|&}\\]]|\\n|$))`, 'gm'),
      type: 2,
      name: 1,
    }],
    infer: [{
      re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)(\s*=\s*[^;\n]*)?/g,
      name: 1,
      rhs: 2,
      rhsTypes: [/^\s*=\s*(?:await\s+)?new\s+([A-Z][\w$.]*)/, /\bas\s+([A-Z][\w$.]*)/, /^\s*=\s*<([A-Z][\w$.]*)>/],
    }],
    untyped: [{ re: /\b([A-Za-z_$][\w$]*)\s*=>/g, names: 1 }, ARROW_NAMES('=>')],
    news: /\bnew\s+([A-Z][\w$.]*)/g,
    notName: ['return', 'await', 'new', 'typeof', 'in', 'of', 'as'],
    chain: /^(?:super|typeof)$/,
    strip: /[!\s]+$/,
    // `const { repo } = host` reads host.repo by name.
    loose: [{ re: /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g, split: true }],
    quoted: /["']([A-Za-z_]\w*)["']/g,
  },

  python: {
    lang: 'python',
    blank: /^[ \t]*from\s+[\w.]+\s+import\s*(?:\([^)]*\)|[^\n]*)|^[ \t]*import\s+[^\n]*/gm,
    heads: /(?<![\w.@])([A-Z]\w*(?:\s*\.\s*[A-Z]\w*)*)/g,
    forms: [
      { kind: 'member', before: /(?:^|\n)[ \t]*(?<name>__?[A-Za-z0-9]\w*)\s*:\s*(?:(?:Optional|ClassVar|Final)\[\s*)?$/, after: new RegExp(`^${PY_AFTER}(?=[ \\t]*(?:=|\\n|$|#))`), pubName: /^(?!__)/ },
      { kind: 'member', before: /\bself\s*\.\s*(?<name>__?[A-Za-z0-9]\w*)\s*:\s*(?:Optional\[\s*)?$/, after: new RegExp(`^${PY_AFTER}(?=\\s*=)`), pubName: /^(?!__)/ },
      { kind: 'param', before: /[(,]\s*(?<name>[A-Za-z_]\w*)\s*:\s*(?:Optional\[\s*)?$/, after: new RegExp(`^${PY_AFTER}(?=\\s*[,)=])`) },
    ],
    inject: /\bself\s*\.\s*(?<l>[A-Za-z_]\w*)\s*(?::[^=\n]*)?=\s*(?<r>[A-Za-z_]\w*)[ \t]*(?=\n|$|#)/gm,
    pubName: /^(?!__)/,
    weak: /^_/,
    weakLabel: 'private',
    ctorAssign: /\bself\s*\.\s*(\w+)\s*(?::[^=\n]*)?=\s*(\w+)[ \t]*(?=\n|$|#)/gm,
    self: ['self', 'cls'],
    bare: false,
    typed: [{ re: new RegExp(`(?:^|[(,\\n])[ \\t]*(?:self\\s*\\.\\s*)?([A-Za-z_]\\w*)\\s*:\\s*(?:Optional\\[\\s*)?(${DOTTED})(?=[\\s,)=\\]|]|$)`, 'gm'), type: 2, name: 1 }],
    infer: [{
      re: /^[ \t]*(?:self\s*\.\s*)?([A-Za-z_]\w*)\s*=(?!=)(\s*=?\s*[^\n]*)?/gm,
      name: 1,
      rhs: 2,
      rhsTypes: [/^\s*=?\s*([A-Z]\w*(?:\.[A-Z]\w*)*)\s*\(/],
    }],
    untyped: [{ re: /\blambda\s+(\w+(?:\s*,\s*\w+)*)\s*:/g, names: 1 }],
    notName: ['return', 'in', 'is', 'not', 'and', 'or', 'lambda'],
    chain: /^(?:super)$/,
    loose: [],
    quoted: /["']([A-Za-z_]\w*)["']/g,
  },

  go: {
    lang: 'go',
    blank: /^[ \t]*package\s+\w+|^[ \t]*import\s*(?:\w+\s+)?"[^"\n]*"|^[ \t]*import\s*\([^)]*\)/gm,
    heads: /(?<![\w.@$])([A-Z]\w*)/g,
    forms: [
      {
        kind: 'member',
        before: /(?:^|[;{}\n])[ \t]*(?<name>[A-Za-z_]\w*)[ \t]+(?:\*|\[\]|\[\d*\])*$/,
        after: /^(?=[ \t]*(?:\n|$|;|\}|`|\/\/))/,
        gateName: /^[a-z_]/,
        weak: /^[a-z_]/,
      },
      { kind: 'param', before: /[(,][ \t\n]*(?<name>[A-Za-z_]\w*)[ \t]+(?:\*|\[\]|\.\.\.)*$/, after: /^(?=[ \t\n]*[,)])/ },
    ],
    weak: /^[a-z_]/,
    weakLabel: 'package',
    ctorAssign: /(?:\b\w+\s*\.\s*)?\b(\w+)\s*(?::|=)\s*(\w+)\s*(?=[,}\n;)]|$)/g,
    self: [],
    selfDecl: /\bfunc\s*\(\s*(\w+)\s+\*?\s*(\w+)\s*(?:\[[^\]]*\])?\s*\)/g,
    bare: false,
    typed: [
      { re: /(?:^|[(,;{\n])[ \t]*([A-Za-z_]\w*)[ \t]+(?:\*|\[\]|\.\.\.)*([A-Z]\w*)(?=[ \t]*(?:[,)=;}\n`]|$))/gm, type: 2, name: 1 },
      { re: /\b(\w+)(?:\s*,\s*\w+)?\s*:?=\s*[\w.]+\.\(\*?([A-Z]\w*)\)/g, type: 2, name: 1 },
    ],
    infer: [{
      re: /\b(\w+)\s*:=(\s*[^\n]*)?/g,
      name: 1,
      rhs: 2,
      rhsTypes: [/^\s*&?([A-Z]\w*)\s*\{/],
    }],
    untyped: [],
    init: { re: /(?<![\w.])&?([A-Z]\w*)\s*\{/g, key: /^\s*([A-Za-z_]\w*)\s*:(?!=)/ },
    notName: ['return', 'range', 'case', 'go', 'defer'],
    chain: /^(?:nil)$/,
    loose: [{ re: /[{,]\s*([A-Za-z_]\w*)\s*:(?!:|=)/g, skip: true }],
  },
};

/** The table for a language, or undefined. JavaScript shares TypeScript's: its classes simply carry no types. */
export const syntaxFor = (language) => MEMBER_SYNTAX[language] ?? (language === 'javascript' ? MEMBER_SYNTAX.typescript : undefined);

/** Languages whose files share one namespace of types for member reach (Java and Kotlin call each other). */
export const FAMILY = { java: 'jvm', kotlin: 'jvm', scala: 'jvm', csharp: 'csharp', go: 'go', typescript: 'js', javascript: 'js', python: 'python' };
