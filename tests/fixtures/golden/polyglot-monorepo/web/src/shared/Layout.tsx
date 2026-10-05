export function Layout({ children }: { children?: unknown }) {
  return <main>{children as never}</main>;
}
