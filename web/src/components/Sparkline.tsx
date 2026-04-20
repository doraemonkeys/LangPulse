import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";

interface SparklinePoint {
  date: string;
  value: number | null;
}

interface SparklineProps {
  points: SparklinePoint[];
  color: string;
  ariaLabel: string;
}

export function Sparkline({ points, color, ariaLabel }: SparklineProps) {
  return (
    <div className="sparkline" aria-label={ariaLabel} role="img">
      <ResponsiveContainer width="100%" height={32}>
        <LineChart data={points} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
