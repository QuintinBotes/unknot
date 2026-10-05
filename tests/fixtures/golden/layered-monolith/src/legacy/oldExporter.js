function exportToCsv(rows) {
  return rows.map((r) => Object.values(r).join(',')).join('\n');
}

function exportToXml(rows) {
  return rows.map((r) => `<row>${Object.values(r).join('|')}</row>`).join('');
}

function legacyBanner() {
  return 'legacy exporter';
}
