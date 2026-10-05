import { createSlice } from '@reduxjs/toolkit';

export const userSlice = createSlice({
  name: 'user',
  initialState: { name: 'anon' },
  reducers: {
    rename(state, action) {
      state.name = action.payload;
    },
  },
});

export const selectUserName = (s: { user: { name: string } }) => s.user.name;
