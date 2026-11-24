// 週ごとの勉強時間の棒グラフ（SVG手書き、ライブラリなし）。
// 棒＝その週の合計、帯＝その時期の目標（min〜max）、点線＝最低ライン。
import { md, fmtH } from './util.js';

export function weeklyChart(series, floor, currentMon) {
  const H = 180, top = 12, bottom = 26;
  const plotH = H - top - bottom;
  const colW = 40, barW = 22;
  const maxTarget = Math.max(0, ...series.map((s) => s.target?.max || 0));
  const maxVal = Math.max(10, maxTarget, ...series.map((s) => s.total));
  const yMax = Math.ceil((maxVal * 1.1) / 10) * 10;
  const y = (v) => top + plotH - (v / yMax) * plotH;
  const W = Math.max(series.length * colW + 8, 260);

  const ticks = [];
  for (let v = 0; v <= yMax; v += 10) ticks.push(v);

  const grid = ticks.map((v) => `<line class="grid" x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>`).join('');

  const cols = series.map((s, i) => {
    const x0 = 4 + i * colW;
    const cx = x0 + colW / 2;
    const band = s.target
      ? `<rect class="band" x="${x0}" width="${colW}" y="${y(s.target.max)}" height="${y(s.target.min) - y(s.target.max)}"/>`
      : '';
    const h = Math.max(0, y(0) - y(s.total));
    const r = Math.min(4, h / 2, barW / 2);
    const bx = cx - barW / 2, by = y(s.total);
    // 上だけ角丸の棒
    const bar = h > 0
      ? `<path class="bar ${s.mon === currentMon ? 'cur' : ''} ${s.target && s.total >= s.target.min ? 'met' : ''}" d="M${bx},${y(0)} V${by + r} Q${bx},${by} ${bx + r},${by} H${bx + barW - r} Q${bx + barW},${by} ${bx + barW},${by + r} V${y(0)} Z"/>`
      : '';
    const tip = `${md(s.mon)}〜の週：${fmtH(s.total)}時間${s.target ? `（目標 ${s.target.min}〜${s.target.max}）` : ''}`;
    const label = `<text class="xl ${s.mon === currentMon ? 'cur' : ''}" x="${cx}" y="${H - 8}" text-anchor="middle">${md(s.mon)}</text>`;
    const hit = `<rect class="bar-hit" x="${x0}" y="${top}" width="${colW}" height="${plotH}" data-tip="${tip}"/>`;
    return band + bar + label + hit;
  }).join('');

  const floorLine = `<line class="floor" x1="0" x2="${W}" y1="${y(floor)}" y2="${y(floor)}"/>`;
  const axis = `<line class="axis" x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>`;

  const yAxis = `<svg class="yaxis" width="28" height="${H}" aria-hidden="true">${ticks
    .map((v) => `<text x="24" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}</svg>`;

  const last = series[series.length - 1];
  return `
    <div class="chart">
      ${yAxis}
      <div class="chart-scroll">
        <svg width="${W}" height="${H}" role="img" aria-label="週ごとの勉強時間の棒グラフ">${grid}${cols}${floorLine}${axis}</svg>
      </div>
    </div>
    <div class="chart-tip" aria-live="polite">${last ? `${md(last.mon)}〜の週：${fmtH(last.total)}時間（棒をタップで各週を表示）` : ''}</div>
    <div class="hbar-legend"><span><i class="lg-bar"></i>週の合計（時間）</span><span><i class="lg-band"></i>目標の幅</span><span><i class="lg-floor"></i>最低 ${floor}h</span></div>`;
}
