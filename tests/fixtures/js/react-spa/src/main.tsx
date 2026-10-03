import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import Home from './features/home/Home';
import { CartPage } from './features/cart/CartPage';
import { Checkout } from './features/cart/Checkout';

const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  {
    path: '/cart',
    element: <CartPage />,
    children: [{ path: 'checkout', element: <Checkout /> }],
  },
]);

export function Root() {
  return <RouterProvider router={router} />;
}
