// =====================================================================
//  AI-агент для песен (Supabase Edge Function).
//  Действия:
//    import  — по ссылке (holychords, YouTube, любой сайт) или названию готовит песню
//    enrich  — дополняет песню: транскрипция, аккорды, ссылка на запись, тональность
//    usage   — статистика расходов (для админа)
//  Доступ: только участники команды. Ключ Claude — в секретах Supabase (ANTHROPIC_API_KEY).
// =====================================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const SB_URL = env("SUPABASE_URL");
// публичный ключ (он и так есть в коде сайта) и служебный — Supabase подставляет его сам
const SB_ANON = env("SUPABASE_ANON_KEY") || "sb_publishable_EEKb-9OVpdp9KGo4d8sJzg_LVEuZXXq";
const SB_SERVICE = env("SUPABASE_SERVICE_ROLE_KEY") || (() => {
  try { const j = JSON.parse(env("SUPABASE_SECRET_KEYS", "{}")); return j.default || Object.values(j)[0] || ""; } catch { return ""; }
})();
// новые ключи (sb_...) — только в apikey, старые (JWT) — ещё и в Authorization
const keyHeaders = (k: string): Record<string, string> => k.startsWith("sb_") ? { apikey: k } : { apikey: k, Authorization: `Bearer ${k}` };
const API_URL = env("ANTHROPIC_BASE_URL", "https://api.anthropic.com") + "/v1/messages";
const MODEL = env("AGENT_MODEL", "claude-sonnet-5-5");
// $ за миллион токенов (вход / выход) и за один веб-поиск — для учёта расходов
const PRICE_IN = 2, PRICE_OUT = 10, PRICE_SEARCH = 0.01;

// как на сайте: строка-подпись части песни
const SECTION_RE = /^(?:\d+[\s.]*)?(куплет|припев|пред-?припев|бридж|мост|вступление|проигрыш|концовка|кода|окончание|запев|тэг|intro|verse|chorus|pre-?chorus|bridge|outro|interlude|instrumental|tag|ending|בית|פזמון|גשר|פתיחה|סיום|מעבר|קודה)[^:]*:$/i;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------- база ----------
async function rest(path: string, init: RequestInit = {}, key = SB_SERVICE) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...keyHeaders(key), "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`db ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
async function whoami(auth: string) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/whoami`, {
    method: "POST", body: "{}",
    headers: { apikey: SB_ANON, Authorization: auth, "Content-Type": "application/json" },
  });
  if (!r.ok) return null;
  return await r.json(); // {role, name} | null
}
async function setting(name: string, d: number) {
  try {
    const rows = await rest(`app_secrets?select=value&name=eq.${name}`);
    return rows?.[0] ? Number(rows[0].value) : d;
  } catch { return d; }
}
async function countSince(iso: string, userId?: string) {
  const q = `agent_log?select=id&created_at=gte.${encodeURIComponent(iso)}` + (userId ? `&user_id=eq.${userId}` : "");
  const r = await fetch(`${SB_URL}/rest/v1/${q}`, {
    headers: { ...keyHeaders(SB_SERVICE), Prefer: "count=exact", Range: "0-0" },
  });
  const cr = r.headers.get("content-range") || "*/0";
  return Number(cr.split("/")[1]) || 0;
}
function userIdFromJwt(auth: string) {
  try { return JSON.parse(atob(auth.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub as string; } catch { return null; }
}

// ---------- страницы ----------
const ENT: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", laquo: "«", raquo: "»", ndash: "–", mdash: "—", hellip: "…" };
function decode(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1)); return isNaN(n) ? m : String.fromCodePoint(n); }
    return ENT[e.toLowerCase()] ?? m;
  });
}
// HTML -> текст; внутри <pre> пробелы сохраняем (там часто аккорды над строками)
export function htmlToText(html: string) {
  html = html.replace(/<(script|style|noscript|svg|head|iframe)[\s\S]*?<\/\1>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const pres: string[] = [];
  html = html.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
    pres.push(decode(inner.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")));
    return `\n@@PRE${pres.length - 1}@@\n`;
  });
  let t = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d|tr|section|article|header|footer)>/gi, "\n").replace(/<[^>]+>/g, " ");
  t = decode(t).split("\n").map(l => l.replace(/[ \t ]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n");
  return t.replace(/@@PRE(\d+)@@/g, (_, i) => "\n<pre>\n" + pres[+i].replace(/\t/g, "    ") + "\n</pre>\n").trim();
}
async function fetchPage(url: string) {
  const r = await fetch(url, {
    redirect: "follow", signal: AbortSignal.timeout(15000),
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
      "Accept-Language": "ru,he;q=0.9,en;q=0.8",
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const ct = r.headers.get("content-type") || "";
  if (!/html|text/.test(ct)) throw new Error("not html");
  return htmlToText(await r.text()).slice(0, 60000);
}
export function youtubeId(u: string) {
  const m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/.exec(u);
  return m ? m[1] : null;
}
async function youtubeInfo(id: string) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=" + id)}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    return { title: j.title as string, author: j.author_name as string };
  } catch { return null; }
}

// ---------- Claude ----------
const FORMAT = `ФОРМАТ ПЕСНИ В НАШЕМ ПЕСЕННИКЕ
- lyrics — текст песни, строка за строкой. Части песни подписаны отдельной строкой с двоеточием на конце:
  для русских песен «Куплет 1:», «Пред-припев:», «Припев:», «Бридж:», «Вступление:», «Проигрыш:», «Концовка:»;
  для песен на иврите «בית 1:», «פזמון:», «גשר:». Между частями — пустая строка.
- Аккорды пишутся прямо в строке в квадратных скобках перед слогом, на котором меняется аккорд:
  «[Am]Ты достоин [F]хвалы, [C]Господь». В строках на иврите так же, в порядке чтения: «[Am]גם כי אלך [Em]בגיא צלמות».
  Если в источнике аккорды стоят над строками, перенеси каждый к нужному слову по позиции.
  Строки только из аккордов (вступление, проигрыш) пиши как «Вступление:» и следующей строкой «[Am] [F] [C] [G]».
- Нотация аккордов как в источнике (H или B), без лишних пробелов: [F#m], [Bb], [C/E], [Gsus4].
- key — тональность по первому/основному аккорду: «G», «Am», «F#m», «Bb».
- chord_chart — заполняй, только если в источнике есть отдельная схема аккордов без текста.
- translit — только для песен на иврите: транскрипция русскими буквами, по одной строке на каждую строку текста
  (без подписей частей и пустых строк), в том же порядке. Стиль, как у нас:
  «לא יפרידו אותי ממך» → «Ло яфриду оти мимха»; «הללויה, אוהב אותך ישוע» → «Алелуя, оэв отха Йешуа»;
  «להגיד חסדך כי גדול אתה» → «Леагид хасдеха ки гадоль ата»; «אבוא אל מזבח אלוהים» → «Аво эль мизбах Элоим».
  Имена Бога с заглавной: Адонай, Элоим, Йешуа. Аккорды в транскрипцию не переносить.
- title — название (для иврита — на иврите), title_alt — второе название (перевод или первая строка),
  original — если это перевод: оригинальное название и исполнитель.
- lang — "ru" или "he".
- tags — 1–2 из списка, если понятно по характеру песни: Прославление (быстрая, радостная), Поклонение (медленная), Переходная.
ВАЖНО: не выдумывай аккорды и слова. Если аккордов в источниках нет — оставь текст без аккордов и напиши об этом в notes.
notes — коротко по-русски: откуда взято и что стоит проверить.`;

const SAVE_TOOL = {
  name: "save_song",
  description: "Сохранить результат: песню в формате нашего песенника. Вызвать один раз в конце.",
  input_schema: {
    type: "object",
    properties: {
      found: { type: "boolean", description: "Удалось ли найти песню" },
      title: { type: "string" }, title_alt: { type: "string" }, original: { type: "string" },
      lang: { type: "string", enum: ["ru", "he"] }, key: { type: "string" },
      lyrics: { type: "string" }, chord_chart: { type: "string" },
      translit: { type: "array", items: { type: "string" } },
      youtube: { type: "string", description: "Ссылка на запись на YouTube, если есть" },
      source_url: { type: "string", description: "Откуда взяты слова/аккорды" },
      tags: { type: "array", items: { type: "string" } },
      notes: { type: "string" },
    },
    required: ["found", "notes"],
  },
};

type Usage = { input: number; output: number; searches: number };
async function callClaude(system: string, user: string, useWeb: boolean, usage: Usage) {
  const key = env("ANTHROPIC_API_KEY");
  if (!key) throw new Error("Не задан ключ Claude API (ANTHROPIC_API_KEY в секретах Supabase)");
  const tools: unknown[] = [SAVE_TOOL];
  if (useWeb) {
    tools.unshift({ type: "web_search_20250305", name: "web_search", max_uses: 4 },
                  { type: "web_fetch_20250910", name: "web_fetch", max_uses: 4, max_content_tokens: 30000 });
  }
  const messages: any[] = [{ role: "user", content: user }];
  for (let step = 0; step < 6; step++) {
    const r = await fetch(API_URL, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 16000, system, tools, messages }),
    });
    const res = await r.json();
    if (!r.ok) throw new Error("Claude API: " + (res?.error?.message || r.status));
    usage.input += (res.usage?.input_tokens || 0) + (res.usage?.cache_creation_input_tokens || 0) + (res.usage?.cache_read_input_tokens || 0);
    usage.output += res.usage?.output_tokens || 0;
    usage.searches += res.usage?.server_tool_use?.web_search_requests || 0;
    const save = (res.content || []).find((b: any) => b.type === "tool_use" && b.name === "save_song");
    if (save) return save.input;
    const last = messages[messages.length - 1];
    if (last.role === "assistant") last.content = [...last.content, ...(res.content || [])];
    else messages.push({ role: "assistant", content: res.content || [] });
    if (res.stop_reason === "pause_turn") continue; // поиск ещё идёт — продолжаем
    messages.push({ role: "user", content: "Вызови save_song с результатом (если не нашёл — found=false и объясни в notes)." });
  }
  throw new Error("Агент не вернул результат");
}

const SYSTEM = `Ты помощник команды прославления (церковь, Израиль; песни на русском и иврите). Ты готовишь песни для их песенника.\n\n${FORMAT}`;

async function doImport(input: string, usage: Usage) {
  input = input.trim();
  const isUrl = /^https?:\/\//i.test(input);
  let user = "", useWeb = true;
  if (isUrl) {
    const yt = youtubeId(input);
    if (yt) {
      const info = await youtubeInfo(yt);
      user = `Пользователь дал запись на YouTube: https://www.youtube.com/watch?v=${yt}\n` +
        (info ? `Название видео: «${info.title}», канал: ${info.author}.\n` : "") +
        `Найди в интернете слова и аккорды этой песни (holychords.pro, ultimate-guitar, сайты с аккордами, для иврита — tab4u.com и подобные). ` +
        `Открой лучший источник и подготовь песню. В youtube укажи эту ссылку.`;
    } else {
      let page = "";
      try { page = await fetchPage(input); } catch (_) { /* пусть Claude сам откроет страницу */ }
      if (page.length > 300) {
        user = `Вот содержимое страницы ${input} (текст страницы, блоки <pre> сохранены как есть):\n\n<page>\n${page}\n</page>\n\n` +
          `Найди на странице песню и подготовь её. source_url = ${input}. ` +
          `Если на странице есть ссылка на YouTube этой песни — укажи её; если нет, можно найти запись поиском (один-два запроса).`;
      } else {
        user = `Открой страницу ${input}, найди на ней песню (слова и аккорды) и подготовь её. source_url = ${input}.`;
      }
    }
  } else {
    user = `Найди песню по запросу: «${input}». Нужны слова и аккорды (holychords.pro, ultimate-guitar, сайты с аккордами; для иврита — tab4u.com и подобные). ` +
      `Открой лучший источник и подготовь песню; найди и ссылку на запись на YouTube.`;
  }
  return await callClaude(SYSTEM, user, useWeb, usage);
}

async function doEnrich(song: any, tasks: string[], usage: Usage) {
  const lines = String(song.lyrics || "").split("\n");
  const textLines = lines.map(l => l.replace(/\[[^\]]*\]/g, "").trim()).filter(t => t && !SECTION_RE.test(t));
  const want: string[] = [];
  if (tasks.includes("chords")) want.push("найди в интернете аккорды этой песни и расставь их в lyrics, не меняя слова (если текст в источнике отличается — оставь наш текст), заполни key");
  if (tasks.includes("key")) want.push("определи тональность (key) по аккордам или по источнику");
  if (tasks.includes("youtube")) want.push("найди запись этой песни на YouTube (лучше оригинальное исполнение) и укажи её в youtube");
  if (tasks.includes("sections")) want.push("разметь части песни (Куплет/Припев/Бридж) подписями в lyrics, не меняя слова и аккорды");
  if (tasks.includes("translit")) want.push(`сделай транскрипцию: translit — ровно ${textLines.length} строк, по одной на каждую строку текста из списка ниже`);
  const useWeb = tasks.some(t => t === "chords" || t === "youtube" || t === "key" && !/\[[A-H]/.test(song.lyrics || ""));
  const user = `Дополни песню из нашего песенника. Задачи:\n- ${want.join("\n- ")}\n\n` +
    `Остальные поля верни как есть. lyrics возвращай полностью.\n\n` +
    `Песня (JSON):\n${JSON.stringify({ title: song.title, title_alt: song.title_alt, original: song.original, lang: song.lang, key: song.key, lyrics: song.lyrics, chord_chart: song.chord_chart }, null, 1)}` +
    (tasks.includes("translit") ? `\n\nСтроки текста для транскрипции (${textLines.length}):\n${textLines.map((t, i) => `${i + 1}. ${t}`).join("\n")}` : "");
  const out = await callClaude(SYSTEM, user, useWeb, usage);
  if (tasks.includes("translit") && Array.isArray(out.translit) && out.translit.length !== textLines.length) {
    out.notes = (out.notes || "") + ` Внимание: строк транскрипции ${out.translit.length}, а строк текста ${textLines.length} — проверьте.`;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const auth = req.headers.get("Authorization") || "";
  const me = await whoami(auth);
  if (!me || !["editor", "admin"].includes(me.role)) return json({ error: "Агент доступен только участникам команды" }, 403);
  // пока агентом пользуются только админы (так дешевле и спокойнее); чтобы открыть всей команде — убрать эту проверку
  if (me.role !== "admin") return json({ error: "AI-агент пока доступен только админу" }, 403);
  const uid = userIdFromJwt(auth.replace(/^Bearer\s+/i, ""));
  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  if (body.action === "usage") {
    if (me.role !== "admin") return json({ error: "только для админа" }, 403);
    const month = new Date(); month.setUTCDate(1); month.setUTCHours(0, 0, 0, 0);
    const rows = await rest(`agent_log?select=user_name,action,cost_usd,ok,created_at&created_at=gte.${encodeURIComponent(month.toISOString())}&order=created_at.desc&limit=1000`);
    const cost = rows.reduce((a: number, r: any) => a + Number(r.cost_usd || 0), 0);
    return json({ month_requests: rows.length, month_cost: Math.round(cost * 100) / 100, recent: rows.slice(0, 15) });
  }

  // лимиты на день, чтобы случайно не потратить лишнее
  const day = new Date(); day.setUTCHours(0, 0, 0, 0);
  const [perUser, perAll] = await Promise.all([setting("agent_daily_user", 30), setting("agent_daily_total", 150)]);
  const [usedUser, usedAll] = await Promise.all([countSince(day.toISOString(), uid || undefined), countSince(day.toISOString())]);
  if (usedUser >= perUser) return json({ error: `На сегодня ваш лимит запросов к агенту исчерпан (${perUser}). Завтра снова можно.` }, 429);
  if (usedAll >= perAll) return json({ error: `На сегодня общий лимит запросов к агенту исчерпан (${perAll}).` }, 429);

  const usage: Usage = { input: 0, output: 0, searches: 0 };
  let result: any = null, error = "";
  try {
    if (body.action === "import") {
      if (!body.input || String(body.input).length > 500) return json({ error: "Нужна ссылка или название песни" }, 400);
      result = await doImport(String(body.input), usage);
    } else if (body.action === "enrich") {
      if (!body.song || !Array.isArray(body.tasks) || !body.tasks.length) return json({ error: "Нужны песня и задачи" }, 400);
      result = await doEnrich(body.song, body.tasks.map(String), usage);
    } else return json({ error: "Неизвестное действие" }, 400);
  } catch (e) { error = String((e as Error).message || e); }

  const cost = usage.input / 1e6 * PRICE_IN + usage.output / 1e6 * PRICE_OUT + usage.searches * PRICE_SEARCH;
  try {
    await rest("agent_log", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: uid, user_name: me.name, action: body.action, input: String(body.input || body.song?.title || "").slice(0, 300),
        ok: !error, error: error.slice(0, 500), input_tokens: usage.input, output_tokens: usage.output, searches: usage.searches, cost_usd: Math.round(cost * 10000) / 10000 }),
    });
  } catch (e) { console.error("log failed", e); }
  if (error) return json({ error }, 502);
  return json({ result, cost: Math.round(cost * 1000) / 1000 });
});
