import type { Cart } from '@app/cart';

export const total = (cart: Cart): number => cart.items.length * 10;
