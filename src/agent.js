/* ======================= AI-агент =======================
   Готовит песню по ссылке или названию и дополняет существующие:
   транскрипция, аккорды, ссылка на запись, тональность, разметка частей.
   Результат всегда открывается в редакторе — человек проверяет и сохраняет. */
const AI_ON = () => !!CLOUD && isMember();
const YT_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/;

async function agentCall(body) {
  if (!db) throw new Error("Нет связи с базой");
  const { data, error } = await db.functions.invoke("agent", { body });
  if (error) {
    let msg = error.message || "Ошибка";
    try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch {}
    if (/Failed to send|Failed to fetch|NetworkError/i.test(msg)) msg = "Агент недоступен — нет связи или он ещё не установлен";
    throw new Error(msg);
  }
  return data;
}

// окно «работаю…» с секундомером; агенту обычно нужно 20–90 секунд
function agentProgress(text) {
  let closed = false, sec = 0;
  const close = modal(`<h3>✨ Агент работает</h3>
    <div class="ai-wait"><div class="ai-spin"></div><div><div id="aiText">${esc(text)}</div><div class="muted" style="font-size:13px"><span id="aiSec">0</span> сек · обычно до минуты-двух</div></div></div>
    <div class="muted" style="font-size:13px;margin-top:10px">Окно можно не закрывать. Результат откроется в редакторе — вы проверите и сохраните.</div>`, () => {});
  const t = setInterval(() => { sec++; const el = document.getElementById("aiSec"); if (el) el.textContent = sec; }, 1000);
  return () => { if (!closed) { closed = true; clearInterval(t); close(); } };
}
function agentError(msg) {
  modal(`<h3>Агент не справился</h3><div style="font-size:15px">${esc(msg)}</div>
    <div class="actions"><button class="btn primary" data-x>Понятно</button></div>`, (m, close) => m.querySelector("[data-x]").onclick = close);
}

function alignTranslit(lyrics, tr) {
  const lines = (lyrics || "").split("\n"), out = lines.map(() => "");
  lyricLineIdx(lyrics || "").forEach((li, k) => { out[li] = (tr[k] || "").trim(); });
  return out;
}
function ytLink(url) { const m = YT_RE.exec(url || ""); return m ? "https://www.youtube.com/watch?v=" + m[1] : ""; }

// результат агента -> черновик для редактора; fields — какие поля брать (null — все)
function agentDraft(out, base, fields) {
  const d = {}, take = f => !fields || fields.includes(f);
  for (const f of ["title", "title_alt", "original", "lang", "key", "lyrics", "chord_chart"]) {
    if (take(f) && typeof out[f] === "string" && out[f].trim()) d[f] = out[f].trim();
  }
  const lyrics = d.lyrics ?? base.lyrics ?? "";
  if (take("translit") && Array.isArray(out.translit) && out.translit.some(Boolean)) d.translit = alignTranslit(lyrics, out.translit);
  else if (d.lyrics && base.translit && base.translit.some(Boolean)) {
    // текст поменялся (добавились аккорды/подписи) — переносим транскрипцию по строкам текста
    const oldIdx = lyricLineIdx(base.lyrics || ""), old = oldIdx.map(i => base.translit[i] || "");
    d.translit = alignTranslit(lyrics, old);
  }
  const yt = ytLink(out.youtube);
  if (take("links") && yt && !(base.links || []).some(l => ytLink(l.url) === yt)) {
    d.links = [...(base.links || []).filter(l => !YT_RE.test(l.url)), { label: "Слушать", url: yt }];
  }
  if (take("tags") && Array.isArray(out.tags)) {
    const ok = out.tags.filter(t => DEFAULT_TAGS.includes(t) || ALL_TAGS.includes(t));
    if (ok.length) d.tags = [...new Set([...(base.tags || []), ...ok])];
  }
  return d;
}
const FIELD_RU = { title: "название", title_alt: "второе название", original: "оригинал", key: "тональность", lyrics: "текст и аккорды", chord_chart: "схема аккордов", translit: "транскрипция", links: "ссылка на запись", tags: "теги", lang: "язык" };

function openDraft(songId, draft, out, what) {
  const notes = [out.notes, out.source_url ? "Источник: " + out.source_url : ""].filter(Boolean).join(" ");
  state.draft = { song: draft, banner: `${what}${notes ? " " + notes : ""}`, changed: Object.keys(draft).map(k => FIELD_RU[k] || k) };
  go(songId ? "edit-" + songId : "new");
}

// «Новая песня по ссылке или названию»
function aiImportDialog() {
  if (!needEdit()) return;
  modal(`<h3>✨ Песня по ссылке или названию</h3>
    <div class="muted" style="font-size:14px">Ссылка на holychords, YouTube или любой сайт с аккордами — или просто название песни. Агент найдёт слова и аккорды, для иврита сделает транскрипцию, а вы проверите и сохраните.</div>
    <div class="field" style="margin-top:12px"><input id="aiIn" placeholder="https://holychords.pro/617 или «Ты достоин хвалы»" autocomplete="off"></div>
    <div class="actions"><button class="btn" data-x>Отмена</button><button class="btn primary" data-ok>Найти</button></div>`, (m, close) => {
    const inp = m.querySelector("#aiIn"); setTimeout(() => inp.focus(), 50);
    m.querySelector("[data-x]").onclick = close;
    const ok = async () => {
      const v = inp.value.trim(); if (!v) return toast("Вставьте ссылку или название");
      close();
      const done = agentProgress(/^https?:/i.test(v) ? "Читаю страницу и готовлю песню…" : "Ищу песню в интернете…");
      try {
        const { result: out, cost } = await agentCall({ action: "import", input: v });
        done();
        if (!out || out.found === false || !(out.lyrics || "").trim()) return agentError(out?.notes || "Не удалось найти песню.");
        // такая песня уже есть?
        const dup = SONGS.find(s => norm(s.title) === norm(out.title || "") || (out.title_alt && norm(s.title) === norm(out.title_alt)));
        const base = { links: [], tags: [], translit: [] };
        const d = agentDraft(out, base, null);
        d.status = "proposed";
        if (!d.links && ytLink(v)) d.links = [{ label: "Слушать", url: ytLink(v) }];
        openDraft(null, d, out, `✨ Черновик от агента${cost ? ` (≈$${cost})` : ""} — проверьте и нажмите «Сохранить».${dup ? ` Похоже, такая песня уже есть: «${dup.title}».` : ""}`);
      } catch (e) { done(); agentError(e.message); }
    };
    m.querySelector("[data-ok]").onclick = ok;
    inp.onkeydown = e => { if (e.key === "Enter") ok(); };
  });
}

// «Дополнить с помощью AI» для существующей песни
function aiEnrichDialog(song) {
  if (!needEdit()) return;
  const hasYt = song.links.some(l => YT_RE.test(l.url));
  const hasSec = song.lyrics.split("\n").some(l => SECTION_RE.test(l.replace(CHORD_TAG, "").trim()));
  const opts = [
    ["chords", "Найти аккорды", !song.has_chords, true],
    ["key", "Определить тональность", !song.key && (song.has_chords || !!song.chord_chart), true],
    ["translit", "Транскрипция русскими буквами", song.lang === "he" && !song.translit.some(Boolean), song.lang === "he"],
    ["youtube", "Найти запись на YouTube", !hasYt, true],
    ["sections", "Разметить куплет / припев", !hasSec && !!song.lyrics.trim(), !!song.lyrics.trim()],
  ].filter(o => o[3]);
  modal(`<h3>✨ Дополнить: ${esc(song.title)}</h3>
    <div class="muted" style="font-size:14px">Что сделать? Результат откроется в редакторе — проверите и сохраните.</div>
    <div class="ai-opts">${opts.map(([k, t, on]) => `<label class="chk"><input type="checkbox" value="${k}" ${on ? "checked" : ""}> ${t}</label>`).join("")}</div>
    <div class="actions"><button class="btn" data-x>Отмена</button><button class="btn primary" data-ok>Запустить</button></div>`, (m, close) => {
    m.querySelector("[data-x]").onclick = close;
    m.querySelector("[data-ok]").onclick = async () => {
      const tasks = [...m.querySelectorAll(".ai-opts input:checked")].map(i => i.value);
      if (!tasks.length) return toast("Отметьте, что сделать");
      close();
      const done = agentProgress(tasks.includes("chords") || tasks.includes("youtube") ? "Ищу в интернете…" : "Работаю над песней…");
      try {
        const payload = { title: song.title, title_alt: song.title_alt, original: song.original || "", lang: song.lang, key: song.key, lyrics: song.lyrics, chord_chart: song.chord_chart };
        const { result: out, cost } = await agentCall({ action: "enrich", song: payload, tasks });
        done();
        if (!out) return agentError("Пустой ответ агента");
        const fields = [];
        if (tasks.includes("chords")) fields.push("lyrics", "key", "chord_chart");
        if (tasks.includes("sections")) fields.push("lyrics");
        if (tasks.includes("key")) fields.push("key");
        if (tasks.includes("translit")) fields.push("translit");
        if (tasks.includes("youtube")) fields.push("links");
        const d = agentDraft(out, song, fields);
        // ничего не меняем, если агент «улучшил» тональность на пустом месте
        if (d.key && song.key && !tasks.includes("key") && !tasks.includes("chords")) delete d.key;
        if (d.lyrics === song.lyrics) delete d.lyrics;
        if (!Object.keys(d).length) return agentError(out.notes || "Агент ничего не нашёл.");
        openDraft(song.id, d, out, `✨ Агент дополнил песню${cost ? ` (≈$${cost})` : ""}. Проверьте и нажмите «Сохранить».`);
      } catch (e) { done(); agentError(e.message); }
    };
  });
}

async function aiUsageHtml() {
  try {
    const u = await agentCall({ action: "usage" });
    return `В этом месяце: ${u.month_requests} ${plural(u.month_requests, "запрос", "запроса", "запросов")}, ≈ $${u.month_cost}`;
  } catch (e) { return esc(e.message); }
}
