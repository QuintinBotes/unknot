export function buildReport(title, author, date, format, locale, timezone, header, footer, rows) {
  const out = [];
  if (rows) {
    for (const row of rows) {
      if (row.visible) {
        for (const cell of row.cells) {
          if (cell.value !== null) {
            if (cell.value !== undefined) {
              if (format === 'csv') {
                out.push(cell.value);
              }
            }
          }
        }
      }
    }
  }
  return { title, author, date, locale, timezone, header, footer, out };
}
