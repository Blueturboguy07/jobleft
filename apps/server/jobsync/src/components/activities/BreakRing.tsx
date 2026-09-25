"use client";

interface BreakRingProps {
  elapsedMs: number;
  plannedMs: number;
  size?: number;
}

// The arc is time REMAINING, so a fresh break is a full ring that empties.
export function BreakRing({ elapsedMs, plannedMs, size = 200 }: BreakRingProps) {
  const stroke = 24;
  const radius = (size - stroke) / 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;

  const isOver = plannedMs > 0 && elapsedMs >= plannedMs;
  const consumed = plannedMs > 0 ? Math.min(elapsedMs / plannedMs, 1) : 1;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
    >
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke="hsl(var(--muted))"
        strokeWidth={stroke}
      />
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={isOver ? "hsl(var(--chart-4))" : "hsl(var(--primary))"}
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={isOver ? 0 : circumference * consumed}
        transform={`rotate(-90 ${center} ${center})`}
      />
    </svg>
  );
}
