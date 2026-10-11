// Озвучка ответов: Gemini TTS (Interactions API) → PCM → MP3 (чистый JS, без ffmpeg)

const TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';
const TTS_VOICE = process.env.GEMINI_TTS_VOICE || 'Kore';
const SAMPLE_RATE = 24000;

// Достаём PCM из WAV, если Google всё же вернул WAV с заголовком
function pcmFromWavOrRaw(buf) {
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    let pos = 12;
    let rate = SAMPLE_RATE;
    while (pos + 8 <= buf.length) {
      const id = buf.toString('ascii', pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      if (id === 'fmt ') rate = buf.readUInt32LE(pos + 12);
      if (id === 'data') return { pcm: buf.subarray(pos + 8, Math.min(buf.length, pos + 8 + size)), rate };
      pos += 8 + size + (size % 2);
    }
    return { pcm: buf.subarray(44), rate };
  }
  return { pcm: buf, rate: SAMPLE_RATE };
}

async function pcmToMp3(pcmBuf, rate) {
  // библиотека ESM, поэтому подключаем динамически
  const lamejs = await import('@breezystack/lamejs');
  // копия в выровненный массив: Int16Array требует чётного смещения в буфере
  const count = Math.floor(pcmBuf.length / 2);
  const samples = new Int16Array(count);
  Buffer.from(samples.buffer).set(pcmBuf.subarray(0, count * 2));
  const encoder = new lamejs.Mp3Encoder(1, rate, 64);
  const out = [];
  const block = 1152;
  for (let i = 0; i < samples.length; i += block) {
    const chunk = encoder.encodeBuffer(samples.subarray(i, i + block));
    if (chunk.length) out.push(Buffer.from(chunk));
  }
  const end = encoder.flush();
  if (end.length) out.push(Buffer.from(end));
  return Buffer.concat(out);
}

async function synthesize(text) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
      response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: SAMPLE_RATE },
      generation_config: { speech_config: [{ voice: TTS_VOICE }] },
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `TTS error ${r.status}`);

  let b64 = null;
  for (const step of data.steps || []) {
    if (step.type !== 'model_output') continue;
    for (const c of step.content || []) if (c.type === 'audio' && c.data) b64 = c.data;
  }
  if (!b64) throw new Error('TTS не вернул аудио');

  const { pcm, rate } = pcmFromWavOrRaw(Buffer.from(b64, 'base64'));
  return await pcmToMp3(pcm, rate);
}

module.exports = { synthesize, pcmToMp3, pcmFromWavOrRaw };
