type Point = { date: string; count: number; amount: number };

export function MetricsChart({
  points,
  title,
  footer,
  metric = "count",
  ariaLabel,
  variant = "default",
}: {
  points: Point[];
  title?: string;
  footer?: string;
  metric?: "count" | "amount";
  ariaLabel?: string;
  variant?: "default" | "hero";
}) {
  const values = points.map((p) => (metric === "amount" ? p.amount : p.count));
  const max = Math.max(1, ...values);
  const hero = variant === "hero";
  const w = 720;
  const h = hero ? 96 : 120;
  const padX = hero ? 1 : 4;
  const padY = hero ? 4 : 8;
  const labelBand = hero ? 0 : 14;
  const gap = hero ? 2.5 : 4;
  const barW = (w - padX * 2 - gap * (points.length - 1)) / Math.max(points.length, 1);
  const peak = Math.max(...values);
  const foot =
    footer === " "
      ? null
      : (footer ??
        (metric === "amount"
          ? `Peak $${peak.toLocaleString(undefined, { maximumFractionDigits: 0 })}/day`
          : `Peak ${peak}/day`));

  return (
    <div className={`metrics-chart${hero ? " metrics-chart--hero" : ""}`}>
      {title ? <p className="metrics-chart-title">{title}</p> : null}
      <svg
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={ariaLabel || title || "Activity chart"}
        className="w-full"
        preserveAspectRatio="none"
      >
        {points.map((p, i) => {
          const v = values[i] ?? 0;
          const usable = h - padY * 2 - labelBand;
          const barH = Math.max(v ? (hero ? 8 : 5) : hero ? 3 : 2, (v / max) * usable);
          const x = padX + i * (barW + gap);
          const y = h - padY - labelBand - barH;
          const showLabel = !hero && (i === 0 || i === points.length - 1 || i % 5 === 0);
          return (
            <g key={p.date}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={barH}
                rx={hero ? 1.5 : 2.5}
                className={v ? "dash-bar-on" : "dash-bar-off"}
              />
              {showLabel ? (
                <text x={x + barW / 2} y={h - 2} textAnchor="middle" className="dash-bar-label">
                  {p.date.slice(8)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {foot ? <p className="dash-chart-foot">{foot}</p> : null}
    </div>
  );
}
