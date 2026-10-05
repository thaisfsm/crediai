import { formatMoney, shortDate } from "@/lib/finance/format";

// Gráficos simples em SVG, sem biblioteca. Uma série cada; o valor de cada ponto aparece ao passar o mouse
// (title) e também na tabela logo abaixo, para não depender só da cor.
const W = 560, H = 180, PAD = { top: 16, right: 24, bottom: 26, left: 24 };

export function AreaChart({ labels, values, title }: { labels: string[]; values: number[]; title: string }) {
  const max = Math.max(...values, 1);
  const x = (index: number) => PAD.left + (index * (W - PAD.left - PAD.right)) / Math.max(values.length - 1, 1);
  const y = (value: number) => PAD.top + (1 - value / max) * (H - PAD.top - PAD.bottom);
  const line = values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(values.length - 1).toFixed(1)},${H - PAD.bottom} L${x(0).toFixed(1)},${H - PAD.bottom} Z`;
  return (
    <figure className="central-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
        <defs><linearGradient id="central-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--central-cyan)" stopOpacity=".35" /><stop offset="100%" stopColor="var(--central-cyan)" stopOpacity="0" /></linearGradient></defs>
        {[0.25, 0.5, 0.75].map((ratio) => <line key={ratio} x1={PAD.left} x2={W - PAD.right} y1={PAD.top + ratio * (H - PAD.top - PAD.bottom)} y2={PAD.top + ratio * (H - PAD.top - PAD.bottom)} className="central-grid" />)}
        <path d={area} fill="url(#central-area)" />
        <path d={line} fill="none" stroke="var(--central-cyan)" strokeWidth={2} strokeLinejoin="round" />
        {values.map((value, index) => (
          <g key={labels[index]}>
            <circle cx={x(index)} cy={y(value)} r={4} className="central-point" />
            <rect x={x(index) - 20} y={PAD.top} width={40} height={H - PAD.top - PAD.bottom} fill="transparent"><title>{`${labels[index]}: ${formatMoney(value)}`}</title></rect>
            <text x={x(index)} y={H - 8} textAnchor="middle" className="central-axis">{labels[index]}</text>
          </g>
        ))}
      </svg>
    </figure>
  );
}

export function BarChart({ items, title }: { items: { month: string; cents: number }[]; title: string }) {
  const max = Math.max(...items.map((item) => item.cents), 1);
  const slot = (W - PAD.left - PAD.right) / items.length;
  const barWidth = Math.min(44, slot - 12);
  const monthLabel = (month: string) => shortDate(`${month}-01`).replace(/^\d+\s*(de\s*)?/i, "") || month;
  return (
    <figure className="central-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
        {[0.25, 0.5, 0.75].map((ratio) => <line key={ratio} x1={PAD.left} x2={W - PAD.right} y1={PAD.top + ratio * (H - PAD.top - PAD.bottom)} y2={PAD.top + ratio * (H - PAD.top - PAD.bottom)} className="central-grid" />)}
        {items.map((item, index) => {
          const height = (item.cents / max) * (H - PAD.top - PAD.bottom);
          const left = PAD.left + index * slot + (slot - barWidth) / 2;
          return (
            <g key={item.month}>
              <path d={roundedTop(left, H - PAD.bottom - height, barWidth, height)} fill="var(--central-cyan)" opacity={item.cents ? 0.9 : 0.25}><title>{`${item.month}: ${formatMoney(item.cents)}`}</title></path>
              <text x={left + barWidth / 2} y={H - 8} textAnchor="middle" className="central-axis">{monthLabel(item.month)}</text>
            </g>
          );
        })}
        <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} className="central-baseline" />
      </svg>
    </figure>
  );
}

// Barra com cantos arredondados só no topo; a base fica reta, presa ao eixo.
function roundedTop(x: number, y: number, width: number, height: number) {
  if (height <= 0) return `M${x},${y} h${width}`;
  const r = Math.min(4, height, width / 2);
  return `M${x},${y + height} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height} Z`;
}
