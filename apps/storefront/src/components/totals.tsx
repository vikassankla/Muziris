/** Totals rows from subtotal to total, right-aligned under a table of lines. */
export function TotalsList({
  rows,
}: {
  rows: { label: string; value: string; strong?: boolean }[];
}) {
  return (
    <dl className="m-0 ml-auto grid min-w-[260px] grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-meta">
      {rows.map((t) => (
        <div key={t.label} className="contents">
          <dt className={t.strong ? 'font-[650]' : 'text-muted-foreground'}>{t.label}</dt>
          <dd className={`m-0 text-right font-mono tabular-nums ${t.strong ? 'font-[650]' : ''}`}>
            {t.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
