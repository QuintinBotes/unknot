export interface Cart {
  items: string[];
}

export function addItem(cart: Cart, item: string): Cart {
  return { items: [...cart.items, item] };
}
