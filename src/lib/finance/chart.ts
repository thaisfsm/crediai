import { formatMoney } from "./format";

// Série do gráfico "Evolução da carteira": um ponto por data (ISO), com o saldo a receber no fim daquele dia.
export type ChartSeries = { dates: string[]; labels: string[]; values: number[] };

export type ChartPoint = { x: number; y: number; date: string; dateLabel: string; cents: number; valueLabel: string };

// Área de desenho no viewBox 0 0 700 220 do SVG.
export const CHART_VIEWBOX = { width: 700, height: 220 };
const PLOT = { left: 96, right: 688, top: 28, bottom: 175 };

function niceCeiling(value: number) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 1.5, 2, 3, 5, 7.5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}

/** "2026-10-13" → "13/10/2026" (a data é do calendário, sem fuso). */
export function chartDateLabel(iso: string) {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

/** Escala do eixo e posição de cada ponto, com a data e o valor que o tooltip daquele ponto mostra. */
export function chartGeometry(series: ChartSeries) {
  const peak = Math.max(0, ...series.values);
  const top = peak > 0 ? niceCeiling(peak) : 100_000;
  const last = Math.max(series.values.length - 1, 1);
  const points: ChartPoint[] = series.values.map((cents, index) => ({
    x: PLOT.left + (index / last) * (PLOT.right - PLOT.left),
    y: PLOT.bottom - (cents / top) * (PLOT.bottom - PLOT.top),
    date: series.dates[index],
    dateLabel: chartDateLabel(series.dates[index]),
    cents,
    valueLabel: formatMoney(cents),
  }));
  return { peak, top, points };
}
