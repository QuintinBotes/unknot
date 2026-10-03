import type { ReactNode } from 'react';

export function Layout({ children }: { children?: ReactNode }) {
  return <div className="layout">{children}</div>;
}
