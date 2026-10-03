import { useState } from 'react';

const id = <T,>(v: T) => v;

export function Panel({ items }: { items: string[] }) {
  const [open, setOpen] = useState(false);
  if (items.length < 3 && open) {
    return <></>;
  }
  return (
    <div className="panel" title='it is "quoted"'>
      Don't panic, it's "fine" - 5 &gt; 3
      {items.map((it) => <li key={it} onClick={() => setOpen(!open)}>{it}</li>)}
      {items.length < 9 && <i>few</i>}
      <>{open ? <b>open</b> : null}</>
    </div>
  );
}

export function sentinel(a: number) {
  if (a > 1) {
    return 1;
  }
  return 2;
}
