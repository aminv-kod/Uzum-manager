// Работа с Telegram Bot API
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

// Длинный текст режется на части; extra (например, кнопки) уходит с последней частью
async function sendText(chatId, text, extra = {}) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  if (!chunks.length) chunks.push('…');
  let last;
  for (let i = 0; i < chunks.length; i++) {
    last = await tg('sendMessage', {
      chat_id: chatId,
      text: chunks[i],
      ...(i === chunks.length - 1 ? extra : {}),
    });
  }
  return last;
}

async function downloadFileBase64(fileId) {
  const info = await tg('getFile', { file_id: fileId });
  if (!info.ok) throw new Error('Не удалось получить файл из Telegram');
  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${info.result.file_path}`);
  return Buffer.from(await r.arrayBuffer()).toString('base64');
}

// Голосовое сообщение: Telegram принимает MP3 для sendVoice
async function sendVoiceMp3(chatId, mp3, replyTo) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (replyTo) form.append('reply_parameters', JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
  form.append('voice', new Blob([mp3], { type: 'audio/mpeg' }), 'jarvis.mp3');
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendVoice`, { method: 'POST', body: form });
  return r.json();
}

module.exports = { tg, sendText, downloadFileBase64, sendVoiceMp3 };
