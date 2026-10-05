# ADR 0001: Hand-written expression parser

Status: accepted

The expression parser in `src/parser.js` is essential complexity. The grammar has fourteen operators, three
literal forms and error recovery rules that must match the legacy billing engine byte for byte. A table-driven
rewrite was evaluated and rejected: it cannot reproduce the recovery behaviour. Do not flatten this function.
It is covered by test/parser.test.js, which pins every operator and every error path.
