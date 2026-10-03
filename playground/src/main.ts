/** The browser side of the playground: wires the editor to the interpreter. */
import { createInterpreter, generateToolsPrompt, tool } from '../../src';
import { json } from '../../src/json';
import { collections } from '../../src/collections';
import { itertools } from '../../src/itertools';
import { functools } from '../../src/functools';
import { string } from '../../src/string';
import { random } from '../../src/random';
import { EXAMPLES } from './examples';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const editor = $<HTMLTextAreaElement>('code');
const output = $<HTMLElement>('output');
const examples = $<HTMLSelectElement>('examples');
const runButton = $<HTMLButtonElement>('run');
const stopButton = $<HTMLButtonElement>('stop');
const status = $<HTMLElement>('status');

// ── Stub tools: what a host would wire to its database ──────────────────────

const regions = ['EU', 'US', 'APAC'];
const products = ['Starter', 'Team', 'Business', 'Enterprise'];
function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const rnd = seeded(7);
const orders = Array.from({ length: 120 }, (_, i) => {
  const day = new Date(Date.UTC(2026, 0, 1) + Math.floor(rnd() * 180) * 86400000);
  return {
    id: 1000 + i,
    date: day,
    customer: `Customer ${1 + Math.floor(rnd() * 25)}`,
    region: regions[Math.floor(rnd() * regions.length)],
    product: products[Math.floor(rnd() * products.length)],
    total: Math.round((20 + rnd() * 980) * 100) / 100,
    status: rnd() < 0.85 ? 'paid' : rnd() < 0.5 ? 'open' : 'refunded',
  };
});
const customers = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: `Customer ${i + 1}`, plan: products[i % 4], churned: i % 7 === 3, seats: 1 + (i * 7) % 40 }));

const tools = {
  fetch_orders: tool({
    description: 'All orders this year. Each has id, date (datetime), customer, region, product, total (float) and status (paid/open/refunded).',
    params: { region: { type: 'str', description: 'EU, US or APAC; all regions when omitted', default: null } },
    handler: ({ region }) => (region ? orders.filter((o) => o.region === region) : orders),
  }),
  fetch_customers: tool({
    description: 'Customers with id, name, plan, seats and churned (bool).',
    params: {},
    handler: () => customers,
  }),
  exchange_rate: tool({
    description: 'Rate to convert from one currency to another, as a float.',
    params: { from_currency: 'str', to_currency: 'str' },
    handler: ({ from_currency, to_currency }) => {
      const usd: Record<string, number> = { USD: 1, EUR: 0.92, GBP: 0.79, JPY: 151.2 };
      if (!(from_currency in usd) || !(to_currency in usd)) throw new Error(`unknown currency: ${from_currency} or ${to_currency}`);
      return usd[to_currency] / usd[from_currency];
    },
  }),
  slow_lookup: tool({
    description: 'Simulates a 300 ms API call; returns the query upper-cased.',
    params: { query: 'str' },
    handler: ({ query }) => new Promise((resolve) => setTimeout(() => resolve(query.toUpperCase()), 300)),
  }),
};

// ── Output ──────────────────────────────────────────────────────────────────

function block(kind: string, content: string | HTMLElement): void {
  const el = document.createElement('div');
  el.className = `out ${kind}`;
  if (typeof content === 'string') el.textContent = content;
  else el.appendChild(content);
  output.appendChild(el);
  output.scrollTop = output.scrollHeight;
}

function renderTable(t: { data: Record<string, unknown>[]; columns: { key: string; label: string }[]; title?: string }): HTMLElement {
  const wrap = document.createElement('div');
  if (t.title) { const h = document.createElement('div'); h.className = 'title'; h.textContent = t.title; wrap.appendChild(h); }
  const table = document.createElement('table');
  const cols = t.columns.length ? t.columns : Object.keys(t.data[0] ?? {}).map((key) => ({ key, label: key }));
  table.innerHTML = `<thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${t.data.slice(0, 200).map((row) => `<tr>${cols.map((c) => `<td>${esc(String(row[c.key] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody>`;
  wrap.appendChild(table);
  if (t.data.length > 200) { const more = document.createElement('div'); more.className = 'muted'; more.textContent = `… ${t.data.length - 200} more rows`; wrap.appendChild(more); }
  return wrap;
}

function renderChart(c: { type: string; data: Record<string, unknown>[]; x: string; y: string | string[]; title?: string }): HTMLElement {
  const wrap = document.createElement('div');
  if (c.title) { const h = document.createElement('div'); h.className = 'title'; h.textContent = c.title; wrap.appendChild(h); }
  const canvas = document.createElement('canvas');
  const W = 640, H = 260, pad = { l: 56, r: 16, t: 12, b: 48 };
  canvas.width = W * 2; canvas.height = H * 2; canvas.style.width = '100%'; canvas.style.maxWidth = W + 'px';
  const ctx = canvas.getContext('2d')!;
  ctx.scale(2, 2);
  const ys = Array.isArray(c.y) ? c.y : [c.y];
  const rows = c.data.slice(0, 60);
  const values = rows.flatMap((r) => ys.map((k) => Number(r[k]) || 0));
  const max = Math.max(1, ...values), min = Math.min(0, ...values);
  const fg = getComputedStyle(document.body).getPropertyValue('--muted').trim() || '#666';
  const palette = ['#2bb5a0', '#0f2a4a', '#f2a541', '#c23b5b'];
  const scaleY = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - (v - min) / (max - min));
  ctx.strokeStyle = fg; ctx.lineWidth = 0.5; ctx.fillStyle = fg; ctx.font = '11px system-ui';
  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4, y = scaleY(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(formatNumber(v), pad.l - 6, y + 4);
  }
  const slot = (W - pad.l - pad.r) / Math.max(1, rows.length);
  if (c.type === 'pie') {
    const total = values.reduce((a, b) => a + b, 0) || 1;
    let angle = -Math.PI / 2;
    const cx = W / 2, cy = (H - pad.b) / 2 + pad.t, r = Math.min(cx, cy) - 20;
    rows.forEach((row, i) => {
      const v = Number(row[ys[0]]) || 0, a = (v / total) * Math.PI * 2;
      ctx.fillStyle = palette[i % palette.length];
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, angle, angle + a); ctx.closePath(); ctx.fill();
      angle += a;
    });
  } else {
    ys.forEach((key, s) => {
      ctx.fillStyle = palette[s % palette.length]; ctx.strokeStyle = palette[s % palette.length]; ctx.lineWidth = 2;
      if (c.type === 'line' || c.type === 'area') {
        ctx.beginPath();
        rows.forEach((row, i) => { const x = pad.l + slot * (i + 0.5), y = scaleY(Number(row[key]) || 0); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.stroke();
        if (c.type === 'area') { ctx.lineTo(pad.l + slot * (rows.length - 0.5), scaleY(0)); ctx.lineTo(pad.l + slot * 0.5, scaleY(0)); ctx.globalAlpha = 0.2; ctx.fill(); ctx.globalAlpha = 1; }
      } else {
        const bw = (slot * 0.7) / ys.length;
        rows.forEach((row, i) => { const v = Number(row[key]) || 0; const x = pad.l + slot * i + slot * 0.15 + bw * s; ctx.fillRect(x, scaleY(Math.max(v, 0)), bw, Math.abs(scaleY(v) - scaleY(0))); });
      }
    });
  }
  ctx.fillStyle = fg; ctx.textAlign = 'center';
  const every = Math.ceil(rows.length / 12);
  rows.forEach((row, i) => { if (i % every === 0) ctx.fillText(String(row[c.x]).slice(0, 10), pad.l + slot * (i + 0.5), H - pad.b + 16); });
  wrap.appendChild(canvas);
  return wrap;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
const formatNumber = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toLocaleString('en-US', { maximumFractionDigits: 2 }));

// ── Running ─────────────────────────────────────────────────────────────────

const modules = [json, collections, itertools, functools, string, random];
let interpreter = makeInterpreter();
let controller: AbortController | null = null;

function makeInterpreter() {
  return createInterpreter({
    tools,
    modules,
    maxIterations: 2_000_000,
    timeoutMs: 3000,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    onPrint: (line) => block('print', line),
    onTable: (t) => block('table', renderTable(t as any)),
    onChart: (c) => block('chart', renderChart(c as any)),
  });
}

async function run(): Promise<void> {
  if (controller) return;
  controller = new AbortController();
  runButton.disabled = true; stopButton.disabled = false;
  output.replaceChildren();
  status.textContent = 'running';
  const started = performance.now();
  try {
    const value = await interpreter.run(editor.value, { signal: controller.signal });
    const ms = (performance.now() - started).toFixed(1);
    if (value !== null && value !== undefined) block('result', typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    status.textContent = `done in ${ms} ms`;
  } catch (e: any) {
    const ms = (performance.now() - started).toFixed(1);
    block('error', `${e.constructor?.pyName ?? e.name}: ${e.baseMessage ?? e.message}${e.line ? `  (line ${e.line}, column ${e.column})` : ''}`);
    status.textContent = `failed after ${ms} ms`;
  } finally {
    controller = null;
    runButton.disabled = false; stopButton.disabled = true;
  }
}

runButton.addEventListener('click', () => void run());
stopButton.addEventListener('click', () => controller?.abort(new Error('stopped from the playground')));
$<HTMLButtonElement>('reset').addEventListener('click', () => { interpreter = makeInterpreter(); block('muted', 'Interpreter reset: globals cleared.'); });
editor.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void run(); }
  if (e.key === 'Tab') { e.preventDefault(); const s = editor.selectionStart; editor.setRangeText('    ', s, editor.selectionEnd, 'end'); }
});

for (const [i, ex] of EXAMPLES.entries()) {
  const opt = document.createElement('option');
  opt.value = String(i); opt.textContent = ex.title;
  examples.appendChild(opt);
}
examples.addEventListener('change', () => { editor.value = EXAMPLES[Number(examples.value)].code; output.replaceChildren(); status.textContent = ''; });
editor.value = EXAMPLES[0].code;

$<HTMLElement>('prompt').textContent = generateToolsPrompt(tools, { includeLanguageNotes: true });
for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) t.classList.toggle('active', t === tab);
    for (const panel of document.querySelectorAll<HTMLElement>('[data-panel]')) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
  });
}
