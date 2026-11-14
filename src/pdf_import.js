/* ======================= импорт песен из PDF =======================
   Тот же разбор, что мы делали для ваших файлов: текст и аккорды берутся из PDF
   (не из картинки), аккорды над строками переносятся в формат [Am] — по их положению
   над словами. Работает прямо в браузере, файлы никуда не отправляются. */
const PDFJS_BASE = window.PDFJS_BASE || "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
let pdfjsReady = null;
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("load " + src)); document.head.appendChild(s); });
}
function loadPdfJs() {
  if (!pdfjsReady) pdfjsReady = (async () => {
    // worker подключаем обычным скриптом — pdf.js тогда работает без отдельного потока (так можно и в окне просмотра)
    await loadScript(PDFJS_BASE + "pdf.min.js");
    await loadScript(PDFJS_BASE + "pdf.worker.min.js");
    return window.pdfjsLib;
  })().catch(e => { pdfjsReady = null; throw e; });
  return pdfjsReady;
}

const PDF_BIDI = /[‎‏‪-‮⁦-⁩]/g;
const PDF_SECTION = /^(?:\d+\s*)?(куплет|припев|пред-?припев|бридж|мост|вступление|проигрыш|концовка|кода|окончание|запев|intro|verse|chorus|pre-?chorus|bridge|outro|interlude|instrumental|tag|ending|ch|v|בית|פזמון|גשר|פתיחה|סיום|מעבר|קודה)(\s*\d+)?(\s*[xх×]\s*\d+)?\s*[.:]?$/i;
const PDF_KEY = /^([A-H])([#b]?)\s*(major|minor|мажор|минор|dur|moll)$/i;
const SECTION_NAMES = { intro: "Вступление", verse: "Куплет", v: "Куплет", chorus: "Припев", ch: "Припев", "pre-chorus": "Пред-припев", prechorus: "Пред-припев", bridge: "Бридж", outro: "Концовка", ending: "Концовка", interlude: "Проигрыш", instrumental: "Проигрыш", tag: "Тэг" };
const nch = t => t.replace(/♭/g, "b").replace(/♯/g, "#").replace(/–/g, "-");
const HEB1 = /[֐-׿]/, CYR1 = /[Ѐ-ӿ]/;

function sectionLabel(text) {
  let t = text.trim().replace(/[:.]+$/, "").trim();
  if (HEB1.test(t)) return t + ":";
  let m = /^(\d+)\s*(\D+)$/.exec(t); if (m) t = `${m[2].trim()} ${m[1]}`;
  m = /^([A-Za-z-]+)\s*(.*)$/.exec(t);
  if (m && SECTION_NAMES[m[1].toLowerCase()]) t = (SECTION_NAMES[m[1].toLowerCase()] + " " + m[2]).trim();
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() + ":";
}
function fixHebPunct(line) {
  if (!HEB1.test(line)) return line;
  return line.replace(/(\S) +([,;:])(?=[֐-׿\[])/g, "$1$2 ").replace(/([֐-׿\]]),(?=[֐-׿\[])/g, "$1, ");
}

// --- символы с координатами ---
let glyphCtx = null;
const glyphCache = {};
function glyphW(c) {
  if (glyphCache[c]) return glyphCache[c];
  try {
    if (!glyphCtx) { glyphCtx = document.createElement("canvas").getContext("2d"); glyphCtx.font = "100px Arial, Helvetica, sans-serif"; }
    return glyphCache[c] = glyphCtx.measureText(c).width || 50;
  } catch { return 50; }
}
function pageChars(tc, pageH) {
  const out = [];
  for (const it of tc.items) {
    const str = (it.str || "").replace(PDF_BIDI, "");
    if (!str.trim()) continue;
    const t = it.transform, size = Math.hypot(t[0], t[1]) || it.height || 10;
    // pdf.js даёт ширину всего куска текста; ширину каждой буквы оцениваем по обычному шрифту
    const chars = [...str], total = it.width || size * 0.5 * chars.length;
    const ws = chars.map(glyphW), sum = ws.reduce((a, b) => a + b, 0) || 1;
    const base = pageH - t[5], rtl = it.dir === "rtl";
    let acc = 0;
    chars.forEach((c, k) => {
      const w = ws[k] / sum * total;
      const x0 = rtl ? t[4] + total - acc - w : t[4] + acc;
      acc += w;
      if (!c.trim()) return;
      out.push({ t: c, x0, x1: x0 + w, base, size, font: it.fontName, top: base - size * 0.8, bottom: base + size * 0.2 });
    });
  }
  return out;
}
function groupLines(chars) {
  const sorted = chars.slice().sort((a, b) => b.size - a.size || a.base - b.base);
  const lines = [];
  for (const c of sorted) {
    let best = null;
    for (const ln of lines) {
      const d = Math.abs(ln.base - c.base);
      if (d < Math.max(ln.size, c.size) * 0.45 && (!best || d < best[0])) best = [d, ln];
    }
    if (best) best[1].chars.push(c); else lines.push({ base: c.base, size: c.size, chars: [c] });
  }
  for (const ln of lines) finishChars(ln);
  return lines.sort((a, b) => a.top - b.top);
}
function finishChars(ln) {
  ln.chars.sort((a, b) => a.x0 - b.x0);
  ln.top = Math.min(...ln.chars.map(c => c.top)); ln.bottom = Math.max(...ln.chars.map(c => c.bottom));
  ln.x0 = Math.min(...ln.chars.map(c => c.x0)); ln.x1 = Math.max(...ln.chars.map(c => c.x1));
  ln.size = Math.max(...ln.chars.map(c => c.size));
  const fonts = {}; ln.chars.forEach(c => fonts[c.font] = (fonts[c.font] || 0) + 1);
  ln.font = Object.entries(fonts).sort((a, b) => b[1] - a[1])[0][0];
}
const mkWord = chars => { const vis = chars.map(c => c.t).join(""); return { chars, vis, rtl: HEB1.test(vis), x0: chars[0].x0, x1: chars[chars.length - 1].x1 }; };
function splitWords(chars) {
  const words = []; let cur = [];
  for (const c of chars) {
    if (cur.length && c.x0 - cur[cur.length - 1].x1 > Math.max(c.size, cur[cur.length - 1].size) * 0.18) { words.push(cur); cur = []; }
    cur.push(c);
  }
  if (cur.length) words.push(cur);
  return fixChordWords(words.map(mkWord));
}
function fixChordWords(words) {
  if (words.some(w => w.rtl || CYR1.test(w.vis))) return words;
  const out = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    if (prev) {
      const a = nch(prev.vis), b = nch(w.vis);
      if ((!isChord(a) || !isChord(b)) && isChord(a + b) && w.x0 - prev.x1 < 12) { out[out.length - 1] = mkWord(prev.chars.concat(w.chars)); continue; }
    }
    out.push(w);
  }
  const res = [];
  for (const w of out) {
    const t = nch(w.vis);
    if (!isChord(t) && /^(?:[A-H][#b]?m?\d?)+$/.test(t)) {
      const parts = []; let cur = [];
      for (const c of w.chars) { if (/[A-H]/.test(c.t) && cur.length) { parts.push(cur); cur = []; } cur.push(c); }
      parts.push(cur);
      if (parts.length > 1 && parts.every(p => isChord(nch(p.map(c => c.t).join(""))))) { parts.forEach(p => res.push(mkWord(p))); continue; }
    }
    res.push(w);
  }
  return res;
}
// распознанный текст: «Аm», «С#т» (кириллица вместо латиницы) -> «Am», «C#m»
const LAT = { "А": "A", "В": "B", "С": "C", "Е": "E", "Н": "H", "Д": "D", "а": "a", "е": "e", "с": "c", "м": "m", "т": "m", "о": "o" };
function latinChord(t) {
  if (isChord(t)) return t;
  const x = t.replace(/[.,;:!'’]+$/, "").replace(/[АВСЕНДаесмто]/g, c => LAT[c]).replace(/^([A-H][#b]?)т/, "$1m");
  return isChord(x) ? x : t;
}
function finishLine(l) {
  const rl = l.words.filter(w => w.rtl).reduce((a, w) => a + w.vis.length, 0), ll = l.words.filter(w => !w.rtl).reduce((a, w) => a + w.vis.length, 0);
  l.rtl = rl > ll;
  // буквы иврита в PDF лежат «визуально» — переворачиваем в обычный порядок чтения
  l.text = (l.rtl ? l.words.slice().reverse().map(w => (w.rtl ? [...w.vis].reverse().join("") : w.vis)) : l.words.map(w => w.vis)).join(" ").replace(/[‐‑]/g, "-").replace(/ /g, " ");
  const toks = l.words.map(w => latinChord(nch(w.vis)));
  l.isChords = toks.length > 0 && toks.some(isChord) && toks.every(t => isChord(t) || CHORD_EXTRA.has(t));
  if (l.isChords) l.words.forEach((w, k) => { if (toks[k] !== nch(w.vis)) w.vis = toks[k]; });
}
function makeLine(words) {
  const l = { words, chars: words.flatMap(w => w.chars) };
  finishChars(l); finishLine(l); return l;
}

// --- две колонки ---
function splitColumns(lines, pageW) {
  const textWords = l => l.words.filter(w => !isChord(nch(w.vis)));
  let best = null;
  for (let x = Math.floor(pageW * 0.3); x < pageW * 0.7; x += 2) {
    let split = 0, crossing = 0;
    for (const l of lines) {
      if (l.words.some(w => w.x0 < x && x < w.x1)) { crossing++; continue; }
      const tw = textWords(l), lw = tw.filter(w => w.x1 <= x), rw = tw.filter(w => w.x0 >= x);
      if (lw.length && rw.length && rw[0].x0 - lw[lw.length - 1].x1 > l.size * 3) split++;
    }
    if (split >= 3 && (!best || split > best[0] || (split === best[0] && crossing < best[1]))) best = [split, crossing, x];
  }
  if (!best) return [lines];
  const x = best[2];
  const isFull = l => {
    const lw = l.words.filter(w => w.x1 <= x), rw = l.words.filter(w => w.x0 >= x);
    return l.words.some(w => w.x0 < x && x < w.x1) || (lw.length && rw.length && rw[0].x0 - lw[lw.length - 1].x1 < l.size * 1.5);
  };
  const right = lines.filter(l => !isFull(l) && l.words.some(w => w.x0 >= x));
  const bandBottom = Math.max(...right.map(l => l.bottom)) + 1;
  const blocks = []; let L = [], R = [], F = [], continuing = true;
  const flushCols = () => { if (L.length || R.length) blocks.push(L.concat(R)); L = []; R = []; };
  const flushFull = () => { if (F.length) blocks.push(F); F = []; };
  for (const l of lines) {
    const below = l.top > bandBottom;
    if (below && PDF_SECTION.test(l.text.trim())) continuing = false;
    if (isFull(l) || (below && !continuing)) { flushCols(); F.push(l); continue; }
    flushFull();
    const lw = l.words.filter(w => w.x1 <= x), rw = l.words.filter(w => w.x0 >= x);
    if (lw.length) L.push(makeLine(lw));
    if (rw.length) R.push(makeLine(rw));
  }
  flushCols(); flushFull();
  return blocks;
}

// --- аккорды над строкой -> [Am] в строке ---
function snapPos(text, pos) {
  if (pos >= text.length) return pos;
  const spans = [...text.matchAll(/\S+/g)].map(m => [m.index, m.index + m[0].length]);
  for (let i = 0; i < spans.length; i++) {
    const [a, b] = spans[i];
    if (pos < a) return a;
    if (pos < b) {
      if (pos - a <= 1 && b - a >= 2) return a;
      if (pos === b - 1 && b - a >= 3 && spans[i + 1]) return spans[i + 1][0];
      return pos;
    }
  }
  return pos;
}
function mergeChords(cl, ll) {
  const text = ll.text;
  const groups = new Map();
  const add = (pos, tok, order) => { if (!groups.has(pos)) groups.set(pos, []); groups.get(pos).push([order, tok]); };
  if (!ll.rtl) {
    const flat = []; let idx = 0;
    ll.words.forEach(w => { w.chars.forEach(c => flat.push([idx++, c])); idx++; });
    for (const cw of cl.words) {
      let pos = text.length;
      for (const [i, c] of flat) if ((c.x0 + c.x1) / 2 >= cw.x0 - 0.5) { pos = i; break; }
      add(snapPos(text, pos), nch(cw.vis), cw.x0);
    }
  } else {
    const starts = []; let idx = 0;
    for (const w of ll.words.slice().reverse()) { starts.push([idx, w]); idx += w.vis.length + 1; }
    for (const cw of cl.words) {
      let pos = text.length;
      for (const [i, w] of starts) if (w.x0 <= cw.x1 + 2) { pos = i; break; }
      add(pos, nch(cw.vis), -cw.x1); // правее стоящий аккорд читается первым
    }
  }
  let out = text;
  for (const pos of [...groups.keys()].sort((a, b) => b - a)) {
    const tok = groups.get(pos).sort((a, b) => a[0] - b[0]).map(([, t]) => `[${t}]`).join("");
    if (pos > out.length) out = out.padEnd(pos);
    out = out.slice(0, pos) + tok + out.slice(pos);
  }
  return out;
}
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

async function parsePdfFile(file) {
  const pdfjsLib = await loadPdfJs();
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const meta = (await doc.getMetadata().catch(() => ({}))).info || {};
  const autowrap = !/word|writer|libreoffice|openoffice|pages/i.test((meta.Creator || "") + (meta.Producer || ""));
  let cols = [], totalChars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p), vp = page.getViewport({ scale: 1 });
    const chars = pageChars(await page.getTextContent(), vp.height);
    totalChars += chars.length;
    const lines = groupLines(chars);
    lines.forEach(l => { l.words = splitWords(l.chars); finishLine(l); });
    cols = cols.concat(splitColumns(lines, vp.width));
  }
  if (totalChars < 5) return { error: "В файле нет текста (похоже, это скан — сохраните страницу как картинку и загрузите её)" };
  const metaTitle = (meta.Title || "").replace(PDF_BIDI, "").trim();
  const song = buildSongFromCols(cols, { autowrap, metaTitle });
  if (!song.title) song.title = file.name.replace(/\.pdf$/i, "");
  return song;
}

// «MOCT:» (латиница после распознавания) -> «МОСТ:»
const CYR_LOOK = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У", a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у" };
const secText = t => { const x = t.trim(); return PDF_SECTION.test(x) ? x : x.replace(/[ABCEHKMOPTXYaceopxy]/g, c => CYR_LOOK[c]); };
const isSecLine = t => PDF_SECTION.test(secText(t));
function buildSongFromCols(cols, { autowrap = false, metaTitle = "", guessTitle = true } = {}) {
  const body = cols.flat();
  const fonts = {}; body.filter(l => !l.isChords).forEach(l => fonts[l.font] = (fonts[l.font] || 0) + 1);
  const mainFont = Object.entries(fonts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const medSize = median(body.map(l => l.size));
  let titleLine = null;
  if (guessTitle) for (const l of body.slice().sort((a, b) => a.top - b.top).slice(0, 3)) {
    if (l.isChords || PDF_SECTION.test(l.text.trim()) || PDF_KEY.test(nch(l.text).trim())) continue;
    if (l.size > medSize * 1.15 || l.font !== mainFont) titleLine = l;
    break;
  }
  const song = { title: titleLine ? titleLine.text : metaTitle, titleDetected: !!titleLine, key: "", lyrics: "" };
  const out = [];
  for (let col of cols) {
    col = col.filter(l => l !== titleLine);
    if (!col.length) continue;
    const gaps = col.slice(1).map((l, i) => l.top - col[i].bottom);
    const medGap = median(gaps), lh = median(col.map(l => l.bottom - l.top));
    let i = 0, prev = null;
    while (i < col.length) {
      const l = col[i];
      if (prev && l.top - prev.bottom > Math.max(medGap * 2.2, lh * 1.2) && out.length && out[out.length - 1] !== "") out.push("");
      const km = PDF_KEY.exec(nch(l.text).trim());
      if (km && !song.key) { song.key = km[1] + km[2] + (/minor|минор|moll/i.test(km[3]) ? "m" : ""); prev = l; i++; continue; }
      if (isSecLine(l.text)) { if (out.length && out[out.length - 1] !== "") out.push(""); out.push(sectionLabel(secText(l.text))); prev = l; i++; continue; }
      let merged, cur;
      if (l.isChords) {
        const nx = col[i + 1];
        if (nx && nx.top - l.bottom < lh * 2.2 && !nx.isChords && !isSecLine(nx.text)) { merged = mergeChords(l, nx); cur = nx; i += 2; }
        else { merged = l.words.map(w => `[${nch(w.vis)}]`).join(" "); cur = l; i++; }
      } else { merged = l.text; cur = l; i++; }
      const plainPrev = (out[out.length - 1] || "").replace(CHORD_TAG, "").trim();
      const colRight = Math.max(...col.filter(x => Math.abs(x.x0 - (prev?.x0 ?? 0)) < (prev?.size ?? 10) * 3).map(x => x.x1), 0);
      if (autowrap && prev && !prev.isChords && plainPrev && !plainPrev.endsWith(":") && merged.replace(CHORD_TAG, "").trim().split(/\s+/).length <= 2
          && !/[.,!?;:…]$/.test(plainPrev) && !prev.rtl && prev.x1 > prev.x0 + (colRight - prev.x0) * 0.8) {
        out[out.length - 1] = out[out.length - 1].replace(/\s+$/, "") + " " + merged.trim();
      } else out.push(merged);
      prev = cur;
    }
  }
  song.lyrics = out.map(fixHebPunct).join("\n").trim().replace(/\n{3,}/g, "\n\n");
  if (!song.title) song.title = (out.map(x => x.replace(CHORD_TAG, "").replace(/\s+/g, " ").trim()).find(x => x && !x.endsWith(":")) || "").replace(/[,.;:!]+$/, "");
  return song;
}

// Аккорды без слов -> «схема»: «Куплет: C A F Bb G»
function chartFromLyrics(lyrics) {
  const res = []; let label = "";
  for (const raw of lyrics.split("\n")) {
    const line = raw.replace(/\[([^\]]+)\]/g, "$1").trim();
    if (!line) continue;
    if (SECTION_RE.test(line)) { label = line; continue; }
    res.push((label ? label + " " : "") + line); label = "";
  }
  if (label) res.push(label);
  return res.join("\n");
}
const lyricLinesOf = t => t.split("\n").map(l => l.replace(CHORD_TAG, "").trim()).filter(l => l && !SECTION_RE.test(l));
const normLine = s => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

// Несколько файлов: «Песня - Слова.pdf» + «Песня - Аккорды.pdf» объединяются в одну песню
function baseName(name) {
  return name.replace(/\.pdf$/i, "").replace(/\s*[-–—]\s*(слова\s+и\s+аккорды|аккорды|слова)\s*$/i, "").replace(/(?<=\S)\(/, " (").trim();
}
async function importPdfFiles(files, onProgress) {
  const groups = new Map();
  for (const f of files) { const b = baseName(f.name); if (!groups.has(b)) groups.set(b, []); groups.get(b).push(f); }
  const results = []; let n = 0;
  for (const [base, fs] of groups) {
    onProgress && onProgress(++n, groups.size, base);
    try {
      const parsed = [];
      for (const f of fs) parsed.push({ f, r: await parsePdfFile(f) });
      const ok = parsed.filter(p => !p.r.error);
      if (!ok.length) { results.push({ base, error: parsed[0].r.error, files: fs.map(f => f.name) }); continue; }
      const isCh = p => /аккорд/i.test(p.f.name), isW = p => /слова/i.test(p.f.name) && !/аккорд/i.test(p.f.name);
      const withLyr = p => lyricLinesOf(p.r.lyrics).length >= 2;
      const ch = ok.find(isCh) || ok.find(p => /\[[A-H]/.test(p.r.lyrics) && withLyr(p)) || null;
      const wd = ok.find(isW) || ok.find(p => p !== ch) || null;
      const notes = [];
      let lyrics, chart = "", key = "", title = "";
      if (ch && withLyr(ch)) {
        lyrics = ch.r.lyrics; key = ch.r.key; title = ch.r.titleDetected ? ch.r.title : "";
        if (wd && wd !== ch) {
          const joined = " " + normLine(lyricLinesOf(lyrics).join(" ")) + " ";
          const missing = lyricLinesOf(wd.r.lyrics).filter(l => { const x = normLine(l); return x && !joined.includes(" " + x + " ") && x !== normLine(wd.r.title) && x !== normLine(base); });
          if (missing.length) { lyrics += "\n\n" + missing.join("\n"); notes.push(`Из файла «Слова» добавлено строк: ${missing.length}`); }
        }
      } else if (wd) {
        lyrics = wd.r.lyrics; title = wd.r.titleDetected ? wd.r.title : "";
        if (ch) { chart = chartFromLyrics(ch.r.lyrics); notes.push("Аккорды только схемой — сохранены как «Схема аккордов»"); }
      } else { lyrics = ok[0].r.lyrics; key = ok[0].r.key; title = ok[0].r.title; }
      const useBase = fs.length > 1 || /[-–—]\s*(слова|аккорды)/i.test(fs[0].name);
      const mainTitle = useBase ? base : (title || base);
      const alt = title && normLine(title) !== normLine(mainTitle) && !normLine(mainTitle).includes(normLine(title)) && !/аккорд|слова/i.test(title) ? title : "";
      results.push({
        base, files: fs.map(f => f.name), notes,
        song: { title: mainTitle, title_alt: alt, key: key || guessKey(lyrics + "\n" + chart), lang: detectLang(lyrics + " " + mainTitle), lyrics, chord_chart: chart },
      });
    } catch (e) {
      results.push({ base, error: /load /.test(e.message) ? "Не удалось загрузить модуль чтения PDF (нужен интернет)" : "Не удалось прочитать PDF", files: fs.map(f => f.name) });
    }
  }
  return results;
}


/* ======================= импорт со скриншота (распознавание текста) =======================
   Tesseract.js распознаёт текст прямо в браузере (модель языка скачивается один раз, ~10–20 МБ).
   Дальше — тот же разбор, что и для PDF: по положению слов определяем аккорды над строками. */
const TESS = window.TESS_PATHS || {};
let tessLib = null; const tessWorkers = {};
async function getTessWorker(langs, onProgress) {
  if (!tessLib) { await loadScript(TESS.script || "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js"); tessLib = window.Tesseract; }
  if (!tessWorkers[langs]) {
    const opts = { logger: m => onProgress && onProgress(m) };
    if (TESS.workerPath) opts.workerPath = TESS.workerPath;
    if (TESS.corePath) opts.corePath = TESS.corePath;
    if (TESS.langPath) opts.langPath = TESS.langPath;
    const chordsOnly = langs === "eng#chords";
    tessWorkers[langs] = tessLib.createWorker(chordsOnly ? "eng" : langs, 1, opts).then(async w => {
      await w.setParameters(chordsOnly ? { preserve_interword_spaces: "1", tessedit_char_whitelist: "ABCDEFGHabdgijmnsu#0123456789/()+-" } : { preserve_interword_spaces: "1" });
      return w; })
      .catch(e => { delete tessWorkers[langs]; throw e; });
  }
  const w = await tessWorkers[langs];
  return w;
}
// Готовим картинку: увеличиваем, переводим в ч/б. Если аккорды выделены цветом (как на сайтах с аккордами),
// делаем два слоя — отдельно чёрный текст и отдельно цветной: так строки аккордов и слов не слипаются.
function prepareImages(img, crop) {
  const r = crop || { x: 0, y: 0, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
  const scale = Math.min(3, Math.max(1, 2000 / r.w));
  const W = Math.round(r.w * scale), H = Math.round(r.h * scale);
  const src = document.createElement("canvas"); src.width = W; src.height = H;
  const g = src.getContext("2d"); g.imageSmoothingQuality = "high";
  g.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H), px = d.data, n = W * H;
  const kind = new Uint8Array(n); // 0 фон, 1 тёмный текст, 2 цветной текст
  let dark = 0, color = 0;
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const R = px[i], G = px[i + 1], B = px[i + 2], mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    const L = 0.299 * R + 0.587 * G + 0.114 * B, sat = mx ? (mx - mn) / mx : 0;
    if (L > 205) continue;
    if (sat > 0.22 && mx > 60) { kind[j] = 2; color++; } else { kind[j] = 1; dark++; }
  }
  // края цветных букв (сглаживание) не должны попадать в слой чёрного текста
  if (color > n * 0.002) {
    const near = new Uint8Array(n), R = Math.max(1, Math.round(scale));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (kind[y * W + x] !== 2) continue;
      for (let dy = -R; dy <= R; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -R; dx <= R; dx++) { const xx = x + dx; if (xx >= 0 && xx < W) near[yy * W + xx] = 1; } }
    }
    for (let j = 0; j < n; j++) if (kind[j] === 1 && near[j]) kind[j] = 3; // 3 — край цветного, никуда не берём
  }
  const layer = keep => {
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const cg = c.getContext("2d"), out = cg.createImageData(W, H), o = out.data;
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      let v = 255;
      if (keep(kind[j])) { const L = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; v = Math.round(L); }
      o[i] = o[i + 1] = o[i + 2] = v; o[i + 3] = 255;
    }
    cg.putImageData(out, 0, 0); return c;
  };
  const split = color > n * 0.002 && dark > n * 0.002;
  // две колонки? ищем вертикальную пустую полосу посередине
  const colInk = new Uint32Array(W);
  for (let j = 0; j < n; j++) if (kind[j] === 1 || kind[j] === 2) colInk[j % W]++;
  let cut = 0, bestRun = 0;
  for (let x = Math.floor(W * 0.3), run = 0; x < W * 0.7; x++) {
    run = colInk[x] <= H * 0.002 ? run + 1 : 0;
    if (run > bestRun) { bestRun = run; cut = x - Math.floor(run / 2); }
  }
  const cols = bestRun >= W * 0.012 && colInk.slice(0, cut).some(v => v > 0) && colInk.slice(cut).some(v => v > 0) ? [[0, cut], [cut, W]] : [[0, W]];
  const crop2 = (c, a, b) => { const o = document.createElement("canvas"); o.width = b - a; o.height = H; o.getContext("2d").drawImage(c, a, 0, b - a, H, 0, 0, b - a, H); return o; };
  const mk = keep => { const full = layer(keep); return cols.map(([a, b]) => ({ canvas: cols.length > 1 ? crop2(full, a, b) : full, dx: a })); };
  return { W, H, split, layers: split ? [mk(k => k === 1), mk(k => k === 2)] : [mk(k => k === 1 || k === 2)] };
}
async function ocrImageToSong(img, { lang = "rus", crop = null, onProgress } = {}) {
  const { W, layers, split } = prepareImages(img, crop);
  const main = lang === "heb" ? "heb" : "rus";
  // слой слов — язык песни; слой цветных аккордов — латиница; без разделения — оба сразу
  const langsFor = i => (split && i === 0 ? main : main + "+eng");
  const shift = (bb, dx) => ({ x0: bb.x0 + dx, x1: bb.x1 + dx, y0: bb.y0, y1: bb.y1 });
  const layerLines = [];
  for (let i = 0; i < layers.length; i++) {
    const worker = await getTessWorker(langsFor(i), onProgress);
    const ls = [];
    for (const [ci, { canvas, dx }] of layers[i].entries()) {
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
      for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const ln of p.lines || [])
        ls.push({ ...ln, col: ci, bbox: shift(ln.bbox, dx), words: (ln.words || []).map(w => ({ ...w, bbox: shift(w.bbox, dx) })) });
    }
    layerLines.push(ls);
  }
  let lines = layerLines[0];
  if (!split) {
    // аккорды тем же цветом, что и слова: строки «из коротких слов» перечитываем в режиме «только аккорды»
    const cw = await getTessWorker("eng#chords", onProgress);
    const chordWordsAll = [];
    for (const [ci, { canvas, dx }] of layers[0].entries()) {
      const { data } = await cw.recognize(canvas, {}, { blocks: true });
      for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const ln of p.lines || [])
        for (const w of ln.words || []) {
          const t = latinChord(nch((w.text || "").trim())), bb = shift(w.bbox, dx);
          if (isChord(t)) { chordWordsAll.push({ ...w, text: t, col: ci, bbox: bb }); continue; }
          // «HmG» -> «Hm» + «G»
          const parts = t.split(/(?=[A-H])/).filter(Boolean);
          if (parts.length > 1 && parts.every(isChord)) {
            const tot = parts.reduce((a, x) => a + x.length, 0); let acc = 0;
            for (const x of parts) { const a = bb.x0 + (bb.x1 - bb.x0) * acc / tot; acc += x.length; chordWordsAll.push({ ...w, text: x, col: ci, bbox: { ...bb, x0: a, x1: bb.x0 + (bb.x1 - bb.x0) * acc / tot } }); }
          }
        }
    }
    const chordLike = ln => {
      const toks = (ln.words || []).map(w => (w.text || "").trim()).filter(Boolean);
      return toks.length && toks.every(t => t.length <= 6) && toks.filter(t => isChord(latinChord(nch(t))) || t.length <= 3).length >= toks.length * 0.6;
    };
    lines = lines.map(ln => {
      if (!chordLike(ln)) return ln;
      const cy0 = ln.bbox.y0, cy1 = ln.bbox.y1;
      const ws = chordWordsAll.filter(w => w.col === ln.col && (w.bbox.y0 + w.bbox.y1) / 2 > cy0 && (w.bbox.y0 + w.bbox.y1) / 2 < cy1);
      // добавляем аккорды, которые первый проход прочитал, а второй — нет
      for (const w of ln.words || []) {
        const t = latinChord(nch((w.text || "").trim()));
        if (isChord(t) && !ws.some(c => Math.min(c.bbox.x1, w.bbox.x1) - Math.max(c.bbox.x0, w.bbox.x0) > 0)) ws.push({ ...w, text: t });
      }
      return ws.length ? { ...ln, words: ws.sort((a, b) => a.bbox.x0 - b.bbox.x0) } : ln;
    });
  }
  if (split) {
    // из цветного слоя берём только аккорды; слова чёрного слоя, которые на них наезжают, — это «мусор» от краёв букв
    const chordWords = [];
    const SEC_WORD = /^(\d+|куплет|припев|пред-?припев|бридж|мост|вступление|проигрыш|концовка|кода|запев|intro|verse|chorus|bridge|outro|бит|פזמון|גשר|בית)[:.]?$/i;
    const keepW = w => { const t = nch((w.text || "").trim()); return isChord(latinChord(t)) || SEC_WORD.test(t); };
    const chordLines = layerLines[1].map(ln => ({ ...ln, words: (ln.words || []).filter(keepW) })).filter(ln => ln.words.length);
    chordLines.forEach(ln => chordWords.push(...ln.words));
    // раздел (цветная плашка) мог частично попасть и в чёрный слой — там его не берём
    const overlaps = w => chordWords.some(c => {
      const ix = Math.min(w.bbox.x1, c.bbox.x1) - Math.max(w.bbox.x0, c.bbox.x0), iy = Math.min(w.bbox.y1, c.bbox.y1) - Math.max(w.bbox.y0, c.bbox.y0);
      return ix > 0 && iy > 0 && ix * iy > 0.3 * Math.min((w.bbox.x1 - w.bbox.x0) * (w.bbox.y1 - w.bbox.y0), (c.bbox.x1 - c.bbox.x0) * (c.bbox.y1 - c.bbox.y0));
    });
    lines = lines.map(ln => ({ ...ln, words: (ln.words || []).filter(w => !overlaps(w)) })).filter(ln => ln.words.length).concat(chordLines);
  }
  if (!lines.length) return { error: "Не удалось распознать текст на картинке" };
  const nCols = layers[0].length;
  let cols = [];
  for (let ci = 0; ci < nCols; ci++) {
    const chars = ocrLinesToChars(lines.filter(l => l.col === ci));
    if (!chars.length) continue;
    const glines = groupLines(chars);
    glines.forEach(l => { l.words = splitWords(l.chars); finishLine(l); });
    // колонки уже разделены по картинке; внутри колонки на всякий случай проверяем ещё раз
    cols = cols.concat(nCols > 1 ? [glines] : splitColumns(glines, W));
  }
  const song = buildSongFromCols(cols, { autowrap: false, guessTitle: false });
  song.titleDetected = false;
  return song;
}
function ocrLinesToChars(lines) {
  const chars = [];
  for (const ln of lines) {
    const lh = ln.bbox.y1 - ln.bbox.y0, size = lh * 0.85, base = ln.bbox.y1 - lh * 0.2;
    // иногда у неуверенно распознанного слова рамка «растягивается» на всю строку — обрезаем по соседу
    const ws0 = (ln.words || []).map(w => ({ ...w, bbox: { ...w.bbox } })).sort((a, b) => a.bbox.x0 - b.bbox.x0);
    for (let k = 0; k < ws0.length - 1; k++) if (ws0[k].bbox.x1 > ws0[k + 1].bbox.x0) ws0[k].bbox.x1 = Math.max(ws0[k].bbox.x0 + 4, ws0[k + 1].bbox.x0 - 4);
    for (const w of ws0) {
      const text = (w.text || "").trim();
      if (!text || /^[|"'`~_.,·•©®-]+$/.test(text)) continue;
      if (w.confidence < 25 && text.length <= 2 && !isChord(latinChord(nch(text)))) continue;
      const rtl = HEB1.test(text);
      const vis = rtl ? [...text].reverse() : [...text];
      const ws = vis.map(glyphW), sum = ws.reduce((a, b) => a + b, 0) || 1, Wd = w.bbox.x1 - w.bbox.x0;
      let acc = 0;
      vis.forEach((c, k) => {
        const cw = ws[k] / sum * Wd, x0 = w.bbox.x0 + acc; acc += cw;
        chars.push({ t: c, x0, x1: x0 + cw, base, size, font: "ocr", top: base - size * 0.8, bottom: base + size * 0.2 });
      });
    }
  }
  return chars;
}
function fileToImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => res(img); img.onerror = () => rej(new Error("img"));
    img.src = url;
  });
}
