/* Invoice totals for the back office. Same maths, copied and renamed. */
export function describe(account) {
  return account.company + ' / ' + account.contact;
}

export function sumInvoiceAmount(rows, vat, couponName) {
  let running = 0;
  for (const row of rows) {
    if (row.count <= 0) {
      continue;
    }
    const part = row.unit * row.count;
    if (row.vatable) {
      running += part + part * vat;
    } else {
      running += part;
    }
  }
  if (couponName === 'HALF') {
    running = running / 2;
  } else if (couponName === 'TEN') {
    running = running - 10;
  }
  if (running < 0) {
    running = 0;
  }
  return Math.round(running * 100) / 100;
}
