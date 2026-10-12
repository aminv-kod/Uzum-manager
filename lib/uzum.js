// Uzum Seller OpenAPI: только чтение. Токен идёт в заголовок Authorization без префикса Bearer.
// Всё считается кодом, а не моделью: цифры в отчётах должны быть точными.

const BASE = 'https://api-seller.uzum.uz/api/seller-openapi';
const DAY = 86400000;
const TZ_OFFSET = 5 * 3600000; // Ташкент, UTC+5
const MAX_ITEMS = Number(process.env.UZUM_MAX_ITEMS || 2000); // потолок строк на один отчёт

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class UzumError extends Error {}

function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x))); // shopIds=1&shopIds=2
    else sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function call(path, query) {
  const token = process.env.UZUM_API_TOKEN;
  if (!token) throw new UzumError('Не задан UZUM_API_TOKEN (Vercel → Settings → Environment Variables).');

  for (let attempt = 0; ; attempt++) {
    const r = await fetch(BASE + path + qs(query), {
      headers: { Authorization: token, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (r.status === 429 && attempt < 2) {
      const wait = Number(r.headers.get('retry-after')) * 1000 || 1000 * (attempt + 1);
      await sleep(Math.min(wait, 4000));
      continue;
    }

    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}

    if (!r.ok) {
      if (r.status === 401 || r.status === 403) throw new UzumError('Uzum отклонил токен. Проверь UZUM_API_TOKEN (без слова Bearer) и права токена.');
      if (r.status === 429) throw new UzumError('Достигнут лимит запросов Uzum. Попробуй позже.');
      const msg = data?.errors?.[0]?.message || data?.error || `HTTP ${r.status}`;
      throw new UzumError(`Uzum API ${path}: ${String(msg).slice(0, 200)}`);
    }
    return data;
  }
}

// ---------- Даты (границы суток по Ташкенту) ----------
function startOfDay(ms) {
  return Math.floor((ms + TZ_OFFSET) / DAY) * DAY - TZ_OFFSET;
}
// days=1: сегодня с 00:00; days=7: последние 7 суток включая сегодня
function periodRange(days, now = Date.now()) {
  const d = Math.min(Math.max(Math.floor(Number(days) || 7), 1), 90);
  return { dateFrom: startOfDay(now) - (d - 1) * DAY, dateTo: now, days: d };
}
function yesterdayRange(now = Date.now()) {
  const todayStart = startOfDay(now);
  return { dateFrom: todayStart - DAY, dateTo: todayStart - 1, days: 1 };
}
const fmtDate = (ms) => new Date(ms + TZ_OFFSET).toISOString().slice(0, 10);

// ---------- Магазины ----------
let shopsCache = { at: 0, list: null };
async function getShops() {
  if (shopsCache.list && Date.now() - shopsCache.at < 10 * 60000) return shopsCache.list;
  const data = await call('/v1/shops');
  const list = (Array.isArray(data) ? data : data?.payload || []).map((s) => ({ id: s.id, name: s.name }));
  shopsCache = { at: Date.now(), list };
  return list;
}
async function shopIdsFor(shopId) {
  if (shopId) return [shopId];
  const shops = await getShops();
  if (!shops.length) throw new UzumError('В кабинете не найдено ни одного магазина.');
  return shops.map((s) => s.id);
}

// ---------- Остатки ----------
// Берём активные товары по всем магазинам. Остаток SKU = quantityActive + quantityFbs.
async function lowStock({ threshold = 5, shopId } = {}) {
  const shops = shopId ? [{ id: shopId, name: String(shopId) }] : await getShops();
  const size = 50;
  const skus = [];
  let truncated = false;

  for (const shop of shops) {
    for (let page = 0; page < 40; page++) {
      const data = await call(`/v1/product/shop/${shop.id}`, { page, size, filter: 'ACTIVE', sortBy: 'LEFTOVERS', order: 'ASC' });
      const list = data?.productList || [];
      for (const p of list) {
        for (const s of p.skuList || []) {
          if (s.archived || s.blocked) continue;
          skus.push({
            shop: shop.name,
            product: p.title || s.productTitle,
            sku: s.skuTitle || s.skuFullTitle,
            code: s.sellerItemCode || s.article || null,
            stock: (Number(s.quantityActive) || 0) + (Number(s.quantityFbs) || 0),
            sold: Number(s.quantitySold) || 0,
            avgDailySales: s.avgdsales ?? null,
          });
        }
      }
      if (list.length < size) break;
      if (skus.length >= MAX_ITEMS) {
        truncated = true;
        break;
      }
    }
  }

  const t = Math.max(Number(threshold) || 0, 0);
  const low = skus.filter((s) => s.stock <= t).sort((a, b) => a.stock - b.stock);
  return { threshold: t, totalSkus: skus.length, outOfStock: low.filter((s) => s.stock === 0).length, lowCount: low.length, truncated, items: low };
}

// ---------- Заказы FBS/DBS ----------
const COUNT_STATUSES = ['CREATED', 'PACKING', 'PENDING_DELIVERY', 'DELIVERING', 'COMPLETED', 'CANCELED', 'RETURNED'];

async function ordersCount({ days = 7, range } = {}) {
  const r = range || periodRange(days);
  const shopIds = await shopIdsFor();
  const out = {};
  for (const status of COUNT_STATUSES) {
    const data = await call('/v2/fbs/orders/count', { shopIds, status, dateFrom: r.dateFrom, dateTo: r.dateTo });
    out[status] = Number(data?.payload) || 0;
  }
  return { from: fmtDate(r.dateFrom), to: fmtDate(r.dateTo), counts: out };
}

// Данные покупателей (ФИО, телефон, адрес) отбрасываем: они не нужны ни отчётам, ни модели
function compactOrder(o) {
  return {
    id: o.id,
    status: o.status,
    scheme: o.scheme,
    created: o.dateCreated,
    deliverUntil: o.deliverUntil,
    acceptUntil: o.acceptUntil,
    price: o.price,
    items: (o.orderItems || []).map((i) => ({ title: i.skuTitle || i.productTitle, qty: i.amount, price: i.sellerPrice })),
  };
}

async function ordersList({ status = 'CREATED', days = 7, scheme, limit = 20 } = {}) {
  const r = periodRange(days);
  const shopIds = await shopIdsFor();
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const data = await call('/v2/fbs/orders', { shopIds, status, scheme, dateFrom: r.dateFrom, dateTo: r.dateTo, page: 0, size: lim });
  const orders = (data?.payload?.orders || []).slice(0, lim).map(compactOrder);
  return { status, total: Number(data?.payload?.totalAmount) || orders.length, shown: orders.length, orders };
}

// ---------- Продажи (финансы) ----------
async function fetchFinanceItems(r) {
  const shopIds = await shopIdsFor();
  const size = 50;
  const items = [];
  let truncated = false;
  let total = 0;
  for (let page = 0; page < 200; page++) {
    const data = await call('/v1/finance/orders', { shopIds, dateFrom: r.dateFrom, dateTo: r.dateTo, page, size, group: false });
    const list = data?.orderItems || [];
    total = Number(data?.totalElements) || total;
    items.push(...list);
    if (list.length < size) break;
    if (items.length >= MAX_ITEMS) {
      truncated = true;
      break;
    }
  }
  return { items, truncated, total };
}

async function salesReport({ days = 7, range, top = 5 } = {}) {
  const r = range || periodRange(days);
  const { items, truncated, total } = await fetchFinanceItems(r);

  const sum = { items: 0, units: 0, revenue: 0, commission: 0, logistics: 0, profit: 0, purchaseCost: 0, returnedUnits: 0, cancelledUnits: 0 };
  const byProduct = new Map();
  const orderIds = new Set();

  for (const i of items) {
    const units = Number(i.amount) || 0;
    const price = Number(i.sellerPrice) || 0;
    sum.items += 1;
    sum.units += units;
    sum.revenue += price * units;
    sum.commission += Number(i.commission) || 0;
    sum.logistics += Number(i.logisticDeliveryFee) || 0;
    sum.profit += Number(i.sellerProfit) || 0;
    sum.purchaseCost += (Number(i.purchasePrice) || 0) * units;
    sum.returnedUnits += Number(i.amountReturns) || 0;
    sum.cancelledUnits += Number(i.cancelled) || 0;
    if (i.orderId != null) orderIds.add(i.orderId);

    const key = i.productId || i.productTitle || i.skuTitle;
    const cur = byProduct.get(key) || { title: i.productTitle || i.skuTitle, units: 0, revenue: 0, profit: 0 };
    cur.units += units;
    cur.revenue += price * units;
    cur.profit += Number(i.sellerProfit) || 0;
    byProduct.set(key, cur);
  }

  const topProducts = [...byProduct.values()].sort((a, b) => b.revenue - a.revenue).slice(0, top);
  return { from: fmtDate(r.dateFrom), to: fmtDate(r.dateTo), orders: orderIds.size, ...sum, topProducts, truncated, totalElements: total };
}

// ---------- Расходы ----------
async function expensesReport({ days = 7, range } = {}) {
  const r = range || periodRange(days);
  const shopIds = await shopIdsFor();
  const size = 100;
  const payments = [];
  let truncated = false;
  for (let page = 0; page < 100; page++) {
    const data = await call('/v1/finance/expenses', { shopIds, dateFrom: r.dateFrom, dateTo: r.dateTo, page, size });
    const list = data?.payload?.payments || [];
    payments.push(...list);
    if (list.length < size) break;
    if (payments.length >= MAX_ITEMS) {
      truncated = true;
      break;
    }
  }

  let outcome = 0;
  let income = 0;
  const bySource = new Map();
  for (const p of payments) {
    if (p.status === 'CANCELED') continue;
    const amt = Number(p.paymentPrice) || 0;
    if (p.type === 'INCOME') income += amt;
    else {
      outcome += amt;
      const key = p.name || p.source || 'без названия';
      bySource.set(key, (bySource.get(key) || 0) + amt);
    }
  }
  const top = [...bySource.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, sumValue]) => ({ name, sum: sumValue }));
  return { from: fmtDate(r.dateFrom), to: fmtDate(r.dateTo), records: payments.length, outcome, income, topExpenses: top, truncated };
}

// ---------- Форматирование для Telegram ----------
const nf = new Intl.NumberFormat('ru-RU');
const money = (n) => `${nf.format(Math.round(n))} сум`;
const STATUS_RU = {
  CREATED: 'новые (ждут подтверждения)',
  PACKING: 'в сборке',
  PENDING_DELIVERY: 'ждут отправки',
  DELIVERING: 'в доставке',
  COMPLETED: 'завершены',
  CANCELED: 'отменены',
  RETURNED: 'возвраты',
};

function formatSales(s) {
  const lines = [
    `📊 Продажи ${s.from} — ${s.to}`,
    `Заказов: ${s.orders}, позиций: ${s.items}, штук: ${s.units}`,
    `Выручка: ${money(s.revenue)}`,
    `Комиссия Uzum: ${money(s.commission)}`,
    `Логистика: ${money(s.logistics)}`,
    `Прибыль продавца: ${money(s.profit)}`,
  ];
  if (s.purchaseCost) lines.push(`Закупка (по заданным ценам): ${money(s.purchaseCost)}`);
  if (s.returnedUnits || s.cancelledUnits) lines.push(`Возвратов: ${s.returnedUnits} шт, отмен: ${s.cancelledUnits} шт`);
  if (s.topProducts.length) {
    lines.push('', 'Топ товаров по выручке:');
    s.topProducts.forEach((p, i) => lines.push(`${i + 1}. ${p.title}: ${p.units} шт, ${money(p.revenue)}`));
  }
  if (s.truncated) lines.push('', `⚠️ Данных больше, чем лимит ${MAX_ITEMS} строк: итог неполный. Возьми период короче.`);
  return lines.join('\n');
}

function formatOrders(o) {
  const lines = [`📦 Заказы FBS/DBS ${o.from} — ${o.to}`];
  for (const [k, v] of Object.entries(o.counts)) lines.push(`${STATUS_RU[k] || k}: ${v}`);
  return lines.join('\n');
}

function formatExpenses(e) {
  const lines = [`💸 Расходы ${e.from} — ${e.to}`, `Списано: ${money(e.outcome)}`];
  if (e.income) lines.push(`Начислено: ${money(e.income)}`);
  if (e.topExpenses.length) {
    lines.push('Крупнейшие:');
    e.topExpenses.forEach((x) => lines.push(`• ${x.name}: ${money(x.sum)}`));
  }
  if (e.truncated) lines.push(`⚠️ Данных больше лимита ${MAX_ITEMS} строк, итог неполный.`);
  return lines.join('\n');
}

function formatLowStock(l, maxLines = 25) {
  if (!l.lowCount) return `📦 Остатки: всё в порядке, ниже порога ${l.threshold} шт ничего нет (SKU проверено: ${l.totalSkus}).`;
  const lines = [`📦 Заканчиваются (≤ ${l.threshold} шт): ${l.lowCount} из ${l.totalSkus} SKU, нулевой остаток: ${l.outOfStock}`];
  l.items.slice(0, maxLines).forEach((s) => lines.push(`• ${s.product}${s.sku && s.sku !== s.product ? ` / ${s.sku}` : ''}: ${s.stock} шт`));
  if (l.lowCount > maxLines) lines.push(`…и ещё ${l.lowCount - maxLines}`);
  if (l.truncated) lines.push('⚠️ Каталог большой, проверена только часть.');
  return lines.join('\n');
}

// Отчёт целиком: используется командой /report и утренней сводкой. Блоки независимы: ошибка одного не ломает остальные.
async function fullReport({ days = 7, range, threshold } = {}) {
  const r = range || periodRange(days);
  const blocks = [];
  const run = async (fn, fmt) => {
    try {
      blocks.push(fmt(await fn()));
    } catch (e) {
      blocks.push(`⚠️ ${e.message}`);
    }
  };
  await run(() => ordersCount({ range: r }), formatOrders);
  await run(() => salesReport({ range: r }), formatSales);
  await run(() => expensesReport({ range: r }), formatExpenses);
  await run(() => lowStock({ threshold: threshold ?? Number(process.env.LOW_STOCK_THRESHOLD || 5) }), (l) => formatLowStock(l, 15));
  return blocks.join('\n\n');
}

module.exports = {
  UzumError, periodRange, yesterdayRange, getShops, lowStock, ordersCount, ordersList, salesReport, expensesReport,
  formatSales, formatOrders, formatExpenses, formatLowStock, fullReport, startOfDay,
};
