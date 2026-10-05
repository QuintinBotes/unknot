export interface Money {
  cents: number;
  currency: string;
}

export function money(cents: number, currency = 'USD'): Money {
  return { cents, currency };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error('currency mismatch');
  }
  return money(a.cents + b.cents, a.currency);
}
