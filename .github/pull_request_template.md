## What and why

<!-- The change, and the problem it solves. Link an issue or a dogfood finding if one drove it. -->

## Verification

<!-- What you ran and what it showed. `npm test` at least. -->

- [ ] `npm test` passes
- [ ] Changes to `runtime/policy`, `runtime/broker`, `runtime/hooks` or `runtime/core/shell.mjs` come with a test that fails without them, and this description says what bypass was tried
- [ ] `CHANGELOG.md` (and `COMPATIBILITY.md` if the matrix changed) updated for anything a user would notice
- [ ] No new npm dependency
- [ ] No secrets or private code in fixtures, docs or commit messages
