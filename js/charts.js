/**
 * MacroTally — tiny inline-SVG charts. Every function returns an SVG (or empty-state) HTML string.
 * Theming via CSS: svg.chart, .grid (gridlines), .tick (axis labels). Series colors are CSS colors, e.g. 'var(--p)'.
 */

const EMPTY = '<div class="chart-empty">No data yet</div>';

const escAttr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f1 = (n) => (Math.round(n * 10) / 10).toString();

function niceNum(range, round) {
  if (!(range > 0)) return 1;
  const exp = Math.floor(Math.log10(range));
  const frac = range / Math.pow(10, exp);
  let nice;
  if (round) nice = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  else nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * Math.pow(10, exp);
}

/**
 * "Nice" tick values covering [min, max] (roughly `count` ticks; first ≤ min, last ≥ max).
 * @param {number} min
 * @param {number} max
 * @param {number} [count=4]
 * @returns {number[]}
 */
export function niceTicks(min, max, count = 4) {
  let lo = Number(min);
  let hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.05 : 1;
    lo -= pad;
    hi += pad;
  }
  const n = Math.max(2, count);
  const step = niceNum(niceNum(hi - lo, false) / (n - 1), true);
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const ticks = [];
  for (let v = start, i = 0; v <= end + step / 2 && i < 50; v += step, i++) {
    ticks.push(Number(v.toFixed(decimals)));
  }
  return ticks;
}

function svgOpen(width, height) {
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" xmlns="http://www.w3.org/2000/svg">`;
}

/**
 * Multi-series line chart.
 * @param {object} o
 * @param {{points:{x:number,y:number}[], color:string, width?:number, dots?:boolean, dash?:boolean}[]} o.series
 * @param {number} [o.width=360]
 * @param {number} [o.height=200]
 * @param {(v:number)=>string} [o.yFmt]
 * @param {{x:number, label:string}[]} [o.xLabels=[]]
 * @returns {string}
 */
export function lineChart({ series, width = 360, height = 200, yFmt = (v) => String(Math.round(v)), xLabels = [] }) {
  const all = (series || []).flatMap((s) => (s.points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  if (!all.length) return EMPTY;
  const fmtY = yFmt || ((v) => String(Math.round(v)));
  let xMin = Math.min(...all.map((p) => p.x));
  let xMax = Math.max(...all.map((p) => p.x));
  if (xMin === xMax) {
    xMin -= 1;
    xMax += 1;
  }
  const ticks = niceTicks(Math.min(...all.map((p) => p.y)), Math.max(...all.map((p) => p.y)), 4);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const labels = ticks.map((t) => fmtY(t));
  const padL = Math.max(28, Math.max(...labels.map((l) => String(l).length)) * 6.5 + 10);
  const padR = 10;
  const padT = 10;
  const padB = xLabels && xLabels.length ? 24 : 10;
  const pw = width - padL - padR;
  const ph = height - padT - padB;
  const sx = (x) => padL + ((x - xMin) / (xMax - xMin)) * pw;
  const sy = (y) => padT + (1 - (y - yMin) / (yMax - yMin || 1)) * ph;

  let out = svgOpen(width, height);
  ticks.forEach((t, i) => {
    const y = f1(sy(t));
    out += `<line class="grid" x1="${padL}" x2="${width - padR}" y1="${y}" y2="${y}"/>`;
    out += `<text class="tick" x="${padL - 6}" y="${y}" text-anchor="end" dominant-baseline="middle">${escAttr(labels[i])}</text>`;
  });
  for (const l of xLabels || []) {
    if (!Number.isFinite(l.x) || l.x < xMin || l.x > xMax) continue;
    const x = sx(l.x);
    const anchor = x < padL + 20 ? 'start' : x > width - padR - 20 ? 'end' : 'middle';
    out += `<text class="tick" x="${f1(x)}" y="${height - 6}" text-anchor="${anchor}">${escAttr(l.label)}</text>`;
  }
  for (const s of series || []) {
    const pts = (s.points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x);
    if (!pts.length) continue;
    const color = escAttr(s.color || 'currentColor');
    const w = s.width ?? 2;
    if (pts.length > 1 && w > 0) {
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${f1(sx(p.x))} ${f1(sy(p.y))}`).join(' ');
      out += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ' stroke-dasharray="4 4"' : ''}/>`;
    }
    if (s.dots || pts.length === 1) {
      const r = s.dots ? 2.5 : Math.max(2.5, w);
      out += pts.map((p) => `<circle cx="${f1(sx(p.x))}" cy="${f1(sy(p.y))}" r="${r}" fill="${color}"/>`).join('');
    }
  }
  return out + '</svg>';
}

/**
 * Vertical bar chart with an optional horizontal reference line.
 * @param {object} o
 * @param {{label:string, value:number, color:string, muted?:boolean}[]} o.bars
 * @param {{value:number, color:string, label?:string}|null} [o.line=null]
 * @param {number} [o.width=360]
 * @param {number} [o.height=160]
 * @param {(v:number)=>string} [o.yFmt]
 * @returns {string}
 */
export function barChart({ bars, line = null, width = 360, height = 160, yFmt }) {
  if (!bars || !bars.length) return EMPTY;
  const fmtY = yFmt || ((v) => String(Math.round(v)));
  const vals = bars.map((b) => Math.max(0, Number(b.value) || 0));
  const lineVal = line && Number.isFinite(Number(line.value)) ? Number(line.value) : null;
  const top = Math.max(...vals, lineVal ?? 0, 1);
  const ticks = niceTicks(0, top, 4);
  const yMax = ticks[ticks.length - 1] || 1;
  const labels = ticks.map((t) => fmtY(t));
  const padL = Math.max(28, Math.max(...labels.map((l) => String(l).length)) * 6.5 + 10);
  const padR = 10;
  const padT = 12;
  const padB = 22;
  const pw = width - padL - padR;
  const ph = height - padT - padB;
  const sy = (y) => padT + (1 - y / yMax) * ph;
  const slot = pw / bars.length;
  const bw = Math.max(2, slot * 0.68);
  const every = Math.max(1, Math.ceil(bars.length / 16));

  let out = svgOpen(width, height);
  ticks.forEach((t, i) => {
    const y = f1(sy(t));
    out += `<line class="grid" x1="${padL}" x2="${width - padR}" y1="${y}" y2="${y}"/>`;
    out += `<text class="tick" x="${padL - 6}" y="${y}" text-anchor="end" dominant-baseline="middle">${escAttr(labels[i])}</text>`;
  });
  bars.forEach((b, i) => {
    const cx = padL + slot * (i + 0.5);
    const v = vals[i];
    const y = sy(v);
    const h = Math.max(0, padT + ph - y);
    const color = escAttr(b.color || 'currentColor');
    if (h > 0) {
      out += `<rect${b.muted ? ' class="muted"' : ''} x="${f1(cx - bw / 2)}" y="${f1(y)}" width="${f1(bw)}" height="${f1(h)}" rx="2" fill="${color}"${b.muted ? ' fill-opacity="0.35"' : ''}><title>${escAttr(b.label)}: ${escAttr(fmtY(v))}</title></rect>`;
    }
    if (i % every === 0) {
      out += `<text class="tick" x="${f1(cx)}" y="${height - 6}" text-anchor="middle">${escAttr(b.label)}</text>`;
    }
  });
  if (lineVal !== null) {
    const y = f1(sy(lineVal));
    const color = escAttr(line.color || 'currentColor');
    out += `<line x1="${padL}" x2="${width - padR}" y1="${y}" y2="${y}" stroke="${color}" stroke-width="1.5" stroke-dasharray="5 4"/>`;
    if (line.label) {
      out += `<text class="tick" x="${width - padR}" y="${f1(Number(y) - 4)}" text-anchor="end" style="fill:${color}">${escAttr(line.label)}</text>`;
    }
  }
  return out + '</svg>';
}
