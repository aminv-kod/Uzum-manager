// Ежедневная утренняя сводка. Запускается Vercel Cron (см. vercel.json), 09:00 по Ташкенту.
const { sendText } = require('../lib/telegram');
const uzum = require('../lib/uzum');

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).send('CRON_SECRET не задан');
  if (req.headers.authorization !== `Bearer ${secret}`) return res.status(401).send('unauthorized');

  const owner = process.env.OWNER_ID;
  if (!owner) return res.status(200).send('OWNER_ID не задан');

  try {
    const body = await uzum.fullReport({ range: uzum.yesterdayRange() });
    await sendText(owner, `☀️ Доброе утро! Сводка за вчера.\n\n${body}`);
  } catch (e) {
    console.error('cron failed:', e.message);
    await sendText(owner, `⚠️ Утренняя сводка не собралась: ${e.message}`).catch(() => {});
  }
  return res.status(200).send('ok');
};
