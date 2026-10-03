// Recognises string literals that are SQL statements. It is deliberately strict about
// SELECT (prose such as "Select the items from the list" must not match) and looser about
// statements whose leading keywords are unambiguous (INSERT INTO, DELETE FROM, ...).

const COL = String.raw`[\w."\x60*()]+(?:\s+as\s+\w+)?`;
const COLS = String.raw`(?:\*|distinct\b|${COL}(?:\s*,\s*${COL})*)`;
const TABLE = String.raw`[\w."\x60\[$][\w."\x60\]\$\{\}]*`;
const AFTER = String.raw`(?:\s+(?:as\s+)?\w+)?\s*(?:$|[;,)]|\b(?:where|join|inner|left|right|full|cross|order|group|limit|union|having|on|offset|fetch)\b)`;

export const SQL_RE = new RegExp(
  String.raw`^\s*(?:select\s+${COLS}\s+from\s+${TABLE}${AFTER}` +
    String.raw`|insert\s+into\s|update\s+[\w."\x60\[\]]+\s+set\s|delete\s+from\s` +
    String.raw`|create\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:table|index|view|function|trigger)\b` +
    String.raw`|alter\s+table\s|drop\s+(?:table|index|view)\b|with\s+\w+\s+as\s*\(|truncate\s+)`,
  'i',
);
