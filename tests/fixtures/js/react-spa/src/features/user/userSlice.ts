import { createSlice } from '@reduxjs/toolkit';

export const userSlice = createSlice({
  name: 'user',
  initialState: { name: '' },
  reducers: {},
});

export function selectUserName(state: { user: { name: string } }): string {
  return state.user.name;
}
