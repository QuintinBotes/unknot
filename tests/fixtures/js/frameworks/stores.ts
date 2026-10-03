import { create } from 'zustand';
import { defineStore } from 'pinia';
import { createContext } from 'react';

export const useBear = create<{ n: number }>()((set) => ({ n: 0 }));
export const useCounter = defineStore('counter', { state: () => ({ n: 0 }) });
export const ThemeContext = createContext('light');
