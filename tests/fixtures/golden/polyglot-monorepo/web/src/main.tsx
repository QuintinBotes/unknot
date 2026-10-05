import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import Home from './features/home/Home';
import { CartPage } from './features/cart/CartPage';
import { Profile } from './features/user/Profile';
import { Catalog } from './features/catalog/Catalog';

const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  { path: '/cart', element: <CartPage /> },
  { path: '/profile', element: <Profile /> },
  { path: '/catalog', element: <Catalog /> },
]);

export function Root() {
  return <RouterProvider router={router} />;
}
