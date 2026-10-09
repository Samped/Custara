import { MetricsChart } from "@/components/app/MetricsChart";

type Point = { date: string; count: number; amount: number };

/** Workspace dashboard activity — thin wrapper over MetricsChart. */
export function DashboardActivityChart({ points }: { points: Point[] }) {
  return (
    <div className="dash-chart">
      <MetricsChart points={points} ariaLabel="Invoice activity, 14 days" />
    </div>
  );
}
