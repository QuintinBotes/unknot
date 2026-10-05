import { add } from '../cart/cartSlice';
import { loadCatalog } from '../catalog/catalogSlice';
import { Layout } from '../../shared/Layout';

export function Profile() {
  loadCatalog();
  return <Layout><button onClick={() => add('gift')}>gift</button></Layout>;
}
