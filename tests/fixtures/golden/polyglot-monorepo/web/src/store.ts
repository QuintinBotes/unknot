import { configureStore } from '@reduxjs/toolkit';
import { cartSlice } from './features/cart/cartSlice';
import { userSlice } from './features/user/userSlice';
import { catalogSlice } from './features/catalog/catalogSlice';

export const store = configureStore({
  reducer: { cart: cartSlice.reducer, user: userSlice.reducer, catalog: catalogSlice.reducer },
});
