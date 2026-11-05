const MODEL = "gemini-3.5-flash-lite";
const MODEL_TIMEOUT_MS = 8000;
const MAX_HISTORY = 6;
const MAX_STATE_CHARS = 850;

const QUICK_REPLIES = [
  [/^(привет|здравствуй|здравствуйте|доброе утро|добрый день|добрый вечер)[!. ]*$/i, "Привет! Я на связи. Чем могу помочь?"],
  [/^(как дела|как ты)[?! .]*$/i, "Спасибо, всё хорошо! Готова помочь. Что хочешь узнать?"],
  [/^(спасибо|благодарю)[!. ]*$/i, "Пожалуйста! Обращайся, если появятся ещё вопросы."],
  [/^(пока|до свидания|до встречи)[!. ]*$/i, "Пока! Хорошего дня!"]
];

function getQuickReply(text) {
  for (const [pattern, reply] of QUICK_REPLIES) {
    if (pattern.test(text.trim())) return reply;
  }
  return null;
}

function readHistory(body) {
  const raw = body?.state?.session?.h ?? body?.session_state?.h;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && (item.r === "u" || item.r === "m") && typeof item.t === "string")
    .slice(-MAX_HISTORY)
    .map((item) => ({ role: item.r === "u" ? "user" : "model", parts: [{ text: item.t.slice(0, 140) }] }));
}

function makeSessionState(history) {
  const compact = history.slice(-MAX_HISTORY).map((item) => ({
    r: item.role === "user" ? "u" : "m",
    t: String(item.parts?.[0]?.text ?? "").slice(0, 140)
  }));
  while (JSON.stringify({ h: compact }).length > MAX_STATE_CHARS && compact.length > 1) compact.shift();
  return { h: compact };
}

function sendAlice(res, body, text, sessionState) {
  const answer = String(text || "Не получилось подготовить ответ. Попробуй ещё раз.").slice(0, 1024);
  return res.status(200).json({
    version: body?.version || "1.0",
    session: body?.session || {},
    response: { text: answer, end_session: false },
    session_state: sessionState || { h: [] }
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body && typeof body === "object" ? body : {};

  const command = String(body?.request?.command ?? body?.request?.original_utterance ?? "").trim();
  const history = readHistory(body);

  if (!command) {
    return sendAlice(res, body, "Я на связи. Напиши, что хочешь узнать.", makeSessionState(history));
  }

  const quickReply = getQuickReply(command);
  if (quickReply) {
    return sendAlice(res, body, quickReply, makeSessionState(history));
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return sendAlice(res, body, "Сейчас ИИ временно недоступен. Попробуй немного позже.", makeSessionState(history));
  }

  const contents = [
    ...history,
    { role: "user", parts: [{ text: command.slice(0, 2000) }] }
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents,
          systemInstruction: {
            parts: [{ text: "Ты — Алиса, дружелюбный и полезный голосовой помощник. Отвечай по-русски, ясно и естественно. Учитывай контекст предыдущих сообщений. Для голосового ответа предпочитай краткие формулировки." }]
          },
          generationConfig: { maxOutputTokens: 220, temperature: 0.7 }
        })
      }
    );

    if (!response.ok) {
      console.error("Gemini API returned HTTP", response.status);
      return sendAlice(res, body, "Сейчас ИИ временно недоступен. Попробуй ещё раз чуть позже.", makeSessionState(history));
    }

    const data = await response.json();
    const answer = data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();

    if (!answer) {
      return sendAlice(res, body, "Не получилось сформировать ответ. Попробуй задать вопрос иначе.", makeSessionState(history));
    }

    const updatedHistory = [
      ...history,
      { role: "user", parts: [{ text: command.slice(0, 140) }] },
      { role: "model", parts: [{ text: answer.slice(0, 140) }] }
    ].slice(-MAX_HISTORY);

    return sendAlice(res, body, answer, makeSessionState(updatedHistory));
  } catch (error) {
    if (error?.name === "AbortError") {
      console.warn("Gemini request timed out after", MODEL_TIMEOUT_MS, "ms");
      return sendAlice(res, body, "Сейчас ИИ отвечает слишком медленно. Попробуй ещё раз через минуту.", makeSessionState(history));
    }
    console.error("Gemini request failed:", error?.message || "Unknown error");
    return sendAlice(res, body, "Произошла временная ошибка. Попробуй ещё раз.", makeSessionState(history));
  } finally {
    clearTimeout(timeout);
  }
}
