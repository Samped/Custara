type Point = { date: string; count: number; amount: number };

export function DashboardActivityChart({ points }: { points: Point[] }) {
  const max = Math.max(1, ...points.map((p) => p.count));
  const w = 560;
  const h = 120;
  const padX = 4;
  const padY = 8;
  const gap = 5;
  const barW = (w - padX * 2 - gap * (points.length - 1)) / points.length;

  return (
    <div className="dash-chart">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Invoice activity, 14 days" className="w-full">
        {points.map((p, i) => {
          const barH = Math.max(p.count ? 5 : 2, (p.count / max) * (h - padY * 2 - 14));
          const x = padX + i * (barW + gap);
          const y = h - padY - 14 - barH;
          const showLabel = i === 0 || i === points.length - 1 || i % 3 === 0;
          return (
            <g key={p.date}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={barH}
                rx={3}
                className={p.count ? "dash-bar-on" : "dash-bar-off"}
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
      <p className="dash-chart-foot">Peak {max}/day</p>
    </div>
  );
}
