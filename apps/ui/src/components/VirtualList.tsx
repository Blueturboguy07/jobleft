// A fixed-row-height virtual list inside a scroll pane that may also hold a sticky header above the list.
// Only the rows near the viewport are mounted, so 50,000 jobs scroll as smoothly as 50. Rows are keyed by job id,
// so a recycled row never shows the facts of the job that was in its place before.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

export interface VirtualListProps<T> {
  items: T[];
  rowHeight: number;
  gap: number;
  keyOf: (item: T) => string;
  render: (item: T, index: number) => ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
  onNearEnd?: () => void;
  overscan?: number;
  label: string;
}

export function VirtualList<T>({ items, rowHeight, gap, keyOf, render, scrollRef, onNearEnd, overscan = 4, label }: VirtualListProps<T>) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState<[number, number]>([0, 12]);
  const pitch = rowHeight + gap;

  useLayoutEffect(() => {
    const pane = scrollRef.current;
    const list = listRef.current;
    if (!pane || !list) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const top = list.offsetTop;
      const scrolled = pane.scrollTop - top;
      const first = Math.max(0, Math.floor(scrolled / pitch) - overscan);
      const last = Math.min(items.length, Math.ceil((scrolled + pane.clientHeight) / pitch) + overscan);
      setRange((r) => (r[0] === first && r[1] === last ? r : [first, last]));
      if (onNearEnd && last >= items.length - overscan - 2) onNearEnd();
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    pane.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(pane);
    return () => { pane.removeEventListener('scroll', onScroll); ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [items.length, pitch, overscan, scrollRef, onNearEnd]);

  // keep keyboard focus on screen: when a row gets focus, make sure it is scrolled into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onFocus = (e: FocusEvent) => {
      const row = (e.target as HTMLElement).closest('[data-row]');
      if (row) (row as HTMLElement).scrollIntoView({ block: 'nearest' });
    };
    list.addEventListener('focusin', onFocus);
    return () => list.removeEventListener('focusin', onFocus);
  }, []);

  const [first, last] = range;
  const rows: ReactNode[] = [];
  for (let i = first; i < last && i < items.length; i++) {
    const it = items[i]!;
    rows.push(
      <div key={keyOf(it)} data-row={i} role="listitem" aria-posinset={i + 1} aria-setsize={items.length}
        style={{ position: 'absolute', top: i * pitch, left: 0, right: 0, height: rowHeight }}>
        {render(it, i)}
      </div>,
    );
  }
  return (
    <div ref={listRef} role="list" aria-label={label} style={{ position: 'relative', height: Math.max(0, items.length * pitch - gap) }}>
      {rows}
    </div>
  );
}
