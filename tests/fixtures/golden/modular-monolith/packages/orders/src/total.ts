import { addMoney, money } from '@shop/shared';
import type { Money } from '@shop/shared';
import type { OrderLine } from './model.ts';

function lineTotal(line: OrderLine): Money {
  return money(line.unit.cents * line.quantity, line.unit.currency);
}

export function orderTotal(lines: OrderLine[]): Money {
  return lines.map(lineTotal).reduce(addMoney, money(0));
}
