import { selectUserName } from '../user/userSlice';
import { Layout } from '../../shared/Layout';

export function CartPage() {
  const name = selectUserName({ user: { name: 'x' } });
  return <Layout>Cart for {name}</Layout>;
}
