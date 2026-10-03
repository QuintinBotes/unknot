import { add } from '../cart/cartSlice';

export function Profile() {
  return <button onClick={() => add('gift')}>Don't click</button>;
}
