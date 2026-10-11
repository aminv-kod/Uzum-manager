// Supabase через REST (без библиотек)
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

const headers = (extra = {}) => ({
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  ...extra,
});

const enabled = () => Boolean(SB_URL && SB_KEY);

async function sb(path, { method = 'GET', body, prefer } = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: headers(prefer ? { Prefer: prefer } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 204) return { ok: true, status: 204, data: null };
  let data = null;
  try {
    data = await r.json();
  } catch {}
  return { ok: r.ok, status: r.status, data };
}

// true, если обновление новое. Telegram иногда повторяет вебхук, дубли пропускаем
async function markUpdate(updateId) {
  if (!enabled() || updateId === undefined) return true;
  const r = await sb('processed_updates', { method: 'POST', body: { update_id: updateId }, prefer: 'return=minimal' });
  if (r.status === 409) return false;
  return true;
}

// ----- История диалога -----
async function loadHistory(chatId) {
  if (!enabled()) return [];
  const r = await sb(`messages?chat_id=eq.${chatId}&order=id.desc&limit=20&select=role,content`);
  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data.reverse().map((m) => ({ role: m.role, parts: [{ text: m.content }] }));
}
async function saveMessage(chatId, role, content) {
  if (!enabled()) return;
  await sb('messages', { method: 'POST', body: { chat_id: chatId, role, content }, prefer: 'return=minimal' });
}
async function clearHistory(chatId) {
  if (!enabled()) return;
  await sb(`messages?chat_id=eq.${chatId}`, { method: 'DELETE' });
}

// ----- Поставщики (группы) -----
async function upsertSupplier(chatId, name, lang) {
  return sb('suppliers?on_conflict=chat_id', {
    method: 'POST',
    body: { chat_id: chatId, name, lang },
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
}
async function setAutoreply(chatId, mode) {
  return sb(`suppliers?chat_id=eq.${chatId}`, { method: 'PATCH', body: { autoreply: mode }, prefer: 'return=minimal' });
}
async function deleteSupplier(chatId) {
  return sb(`suppliers?chat_id=eq.${chatId}`, { method: 'DELETE' });
}
async function getSupplierByChat(chatId) {
  const r = await sb(`suppliers?chat_id=eq.${chatId}&select=chat_id,name,lang,autoreply`);
  return r.ok && r.data?.[0] ? r.data[0] : null;
}
async function listSuppliers() {
  const r = await sb('suppliers?select=chat_id,name,lang,autoreply&order=name.asc');
  return r.ok && Array.isArray(r.data) ? r.data : [];
}
// Поиск по названию без учёта регистра: сначала точное, потом по вхождению
async function findSupplier(query) {
  const all = await listSuppliers();
  const q = String(query || '').trim().toLowerCase();
  return all.find((s) => s.name.toLowerCase() === q) || all.find((s) => s.name.toLowerCase().includes(q)) || null;
}

// ----- Сообщения из групп поставщиков (только для чтения владельцем) -----
async function logGroupMessage(chatId, fromName, text, isOwner = false) {
  if (!enabled()) return;
  await sb('group_messages', {
    method: 'POST',
    body: { chat_id: chatId, from_name: fromName, text: String(text).slice(0, 1500), is_owner: isOwner },
    prefer: 'return=minimal',
  });
}
// Последние сообщения самого владельца: образцы его стиля
async function recentOwnerMessages(chatId, limit = 8) {
  const r = await sb(`group_messages?chat_id=eq.${chatId}&is_owner=eq.true&order=id.desc&limit=${limit}&select=text`);
  return r.ok && Array.isArray(r.data) ? r.data.reverse().map((m) => m.text) : [];
}
async function recentGroupMessages(chatId, limit = 15) {
  const r = await sb(`group_messages?chat_id=eq.${chatId}&order=id.desc&limit=${limit}&select=from_name,text,is_owner,created_at`);
  return r.ok && Array.isArray(r.data) ? r.data.reverse() : [];
}

// ----- Заказы -----
// extra: { kind: 'reply', reply_to, as_voice } для черновиков ответов поставщику
async function createOrder(supplierChatId, supplierName, text, extra = {}) {
  const r = await sb('orders', {
    method: 'POST',
    body: { supplier_chat_id: supplierChatId, supplier_name: supplierName, text, status: 'pending', ...extra },
    prefer: 'return=representation',
  });
  return r.ok && r.data?.[0] ? r.data[0] : null;
}
async function getOrder(id) {
  const r = await sb(`orders?id=eq.${Number(id)}&select=*`);
  return r.ok && r.data?.[0] ? r.data[0] : null;
}
// Меняет статус только если заказ ещё в ожидаемом статусе (защита от двойного нажатия)
async function setOrderStatus(id, from, to) {
  const r = await sb(`orders?id=eq.${Number(id)}&status=eq.${from}`, {
    method: 'PATCH',
    body: { status: to },
    prefer: 'return=representation',
  });
  return r.ok && Array.isArray(r.data) && r.data.length > 0;
}

// ----- Лимит автоответов и настройки -----
async function logReply(chatId) {
  if (!enabled()) return;
  await sb('reply_log', { method: 'POST', body: { chat_id: chatId }, prefer: 'return=minimal' });
}
async function countRecentReplies(chatId, minutes = 60) {
  const since = new Date(Date.now() - minutes * 60000).toISOString();
  const r = await sb(`reply_log?chat_id=eq.${chatId}&created_at=gte.${encodeURIComponent(since)}&select=id`);
  return r.ok && Array.isArray(r.data) ? r.data.length : 0;
}
async function getSetting(key) {
  const r = await sb(`settings?key=eq.${encodeURIComponent(key)}&select=value`);
  return r.ok && r.data?.[0] ? r.data[0].value : null;
}
async function setSetting(key, value) {
  return sb('settings?on_conflict=key', {
    method: 'POST',
    body: { key, value },
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
}
async function deleteSetting(key) {
  return sb(`settings?key=eq.${encodeURIComponent(key)}`, { method: 'DELETE' });
}

module.exports = {
  setAutoreply, recentOwnerMessages, logReply, countRecentReplies, getSetting, setSetting, deleteSetting,
  enabled, markUpdate, loadHistory, saveMessage, clearHistory,
  upsertSupplier, deleteSupplier, getSupplierByChat, listSuppliers, findSupplier,
  logGroupMessage, recentGroupMessages, createOrder, getOrder, setOrderStatus,
};
