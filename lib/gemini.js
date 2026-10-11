// Gemini: диалог с вызовом инструментов (function calling)
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const MAX_STEPS = 5;

async function generate(body) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Gemini error ${r.status}`);
  return data;
}

// declarations: описание инструментов; handlers: { имя: async (args) => объект-результат }
async function runAgent({ history, userParts, systemPrompt, declarations, handlers }) {
  const contents = [...history, { role: 'user', parts: userParts }];
  const base = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.6 },
  };
  if (declarations?.length) base.tools = [{ functionDeclarations: declarations }];

  for (let step = 0; step < MAX_STEPS; step++) {
    const data = await generate({ ...base, contents });
    const content = data?.candidates?.[0]?.content;
    const parts = content?.parts || [];
    const calls = parts.filter((p) => p.functionCall);

    if (!calls.length) {
      const text = parts.map((p) => p.text || '').join('').trim();
      return text || 'Не получилось сформулировать ответ, попробуй переспросить.';
    }

    // ответ модели с вызовами возвращаем как есть (так сохраняются служебные подписи Gemini)
    contents.push({ role: 'model', parts });

    const responses = [];
    for (const p of calls) {
      const { name, args } = p.functionCall;
      let result;
      try {
        result = handlers[name] ? await handlers[name](args || {}) : { ok: false, error: `Неизвестный инструмент ${name}` };
      } catch (e) {
        result = { ok: false, error: e.message };
      }
      responses.push({ functionResponse: { name, response: result } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return 'Не смог завершить задачу за разумное число шагов. Попробуй сформулировать проще.';
}

// Один запрос без инструментов, ответ строго JSON по схеме (для автоответов поставщикам)
async function generateJson({ systemPrompt, userParts, schema }) {
  const data = await generate({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: userParts }],
    generationConfig: { temperature: 0.5, responseMimeType: 'application/json', responseSchema: schema },
  });
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  return JSON.parse(text);
}

module.exports = { runAgent, generateJson };
