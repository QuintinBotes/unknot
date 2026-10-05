import { createSlice } from '@reduxjs/toolkit';
import { selectUserName } from '../user/userSlice';

export const catalogSlice = createSlice({
  name: 'catalog',
  initialState: { items: [] as string[] },
  reducers: {},
});

export function loadCatalog() {
  return selectUserName({ user: { name: 'x' } });
}
