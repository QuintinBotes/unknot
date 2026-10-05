import { add } from '../cart/cartSlice';
import { selectUserName } from '../user/userSlice';
import { Layout } from '../../shared/Layout';

export function Catalog() {
  add(selectUserName({ user: { name: 'x' } }));
  return <Layout>Catalog</Layout>;
}
