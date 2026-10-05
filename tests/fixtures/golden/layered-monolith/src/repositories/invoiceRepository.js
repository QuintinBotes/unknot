const rows = [];

export function saveInvoice(invoice) {
  rows.push(invoice);
  return { id: rows.length };
}
