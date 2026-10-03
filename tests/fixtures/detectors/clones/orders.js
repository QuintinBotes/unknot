// Order totals for the storefront.
export function formatName(user) {
  return `${user.first} ${user.last}`;
}

export function computeOrderTotal(items, taxRate, discountCode) {
  let subtotal = 0;
  for (const item of items) {
    if (item.quantity <= 0) {
      continue;
    }
    const line = item.price * item.quantity;
    if (item.taxable) {
      subtotal += line + line * taxRate;
    } else {
      subtotal += line;
    }
  }
  if (discountCode === 'HALF') {
    subtotal = subtotal / 2;
  } else if (discountCode === 'TEN') {
    subtotal = subtotal - 10;
  }
  if (subtotal < 0) {
    subtotal = 0;
  }
  return Math.round(subtotal * 100) / 100;
}
