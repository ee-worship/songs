#!/usr/bin/env python3
"""Собирает index.html: шаблон + песни (+ транскрипция, теги, ссылки)."""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).parent
SEC = re.compile(r":\s*$")
CH = re.compile(r"\[[^\]]*\]")


def song_id(title):
    h = 2166136261
    for b in title.encode("utf-8"):
        h = ((h ^ b) * 16777619) & 0xFFFFFFFF
    return "song-" + format(h, "x")


def load(p):
    p = Path(p)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


src, dst = Path(sys.argv[1]), Path(sys.argv[2])
translit = load(ROOT.parent / "translit.json")
# транскрипция по строкам: «иврит | транскрипция»
def _k(t):
    t = re.sub(r"[\u0591-\u05C7]", "", t)
    return " ".join(re.sub(r"[^\u05D0-\u05EA\s]", " ", t).split())
line_tr = {}
_lt = ROOT.parent / "translit_lines.txt"
if _lt.exists():
    for ln in _lt.read_text(encoding="utf-8").splitlines():
        if "|" in ln and not ln.startswith("#"):
            he, tr = ln.split("|", 1)
            line_tr[_k(he)] = tr.strip()
extra = load(ROOT.parent / "song_extra.json")  # {title: {"tags": [...], "links": [...]}}
songs = []
for s in json.loads(src.read_text(encoding="utf-8")):
    lines = s.get("lyrics", "").split("\n")
    tr_lines = [""] * len(lines)
    tr = translit.get(s["title"])
    if tr:
        idx = [i for i, l in enumerate(lines) if CH.sub("", l).strip() and not SEC.search(CH.sub("", l).strip())]
        if len(idx) == len(tr):
            for i, t in zip(idx, tr):
                tr_lines[i] = t
        else:
            print("! транскрипция не совпала по строкам:", s["title"])
    if not tr and s.get("lang") == "he" and line_tr:
        cand = [""] * len(lines); hits = heb = 0
        for i, l in enumerate(lines):
            t = CH.sub("", l).strip()
            if not t or SEC.search(t) or not re.search(r"[\u0590-\u05FF]", t):
                continue
            heb += 1
            v = line_tr.get(_k(t))
            if v:
                cand[i] = v; hits += 1
        if heb and hits >= heb * 0.6:
            tr_lines, tr = cand, True
            if hits < heb:
                print(f"  транскрипция частично: {s['title']} ({hits}/{heb})")
        elif heb:
            print(f"! нет транскрипции: {s['title']} ({hits}/{heb})")
    ex = extra.get(s["title"], {})
    songs.append({
        "id": song_id(s["title"]), "title": s["title"], "title_alt": s.get("title_alt", ""),
        "key": s.get("key", ""), "lang": s.get("lang", "ru"), "lyrics": s.get("lyrics", ""),
        "chord_chart": s.get("chord_chart", ""), "has_chords": bool(s.get("has_chords")),
        "translit": tr_lines if tr else [], "tags": sorted(set(s.get("tags", [])) | set(ex.get("tags", []))), "links": ex.get("links", []),
        "status": ex.get("status", "songbook"),
        "review": [n for n in s.get("notes", []) if re.search(r"больше|Word|только схемой|Не найдено", n)],
    })
assert len({s["id"] for s in songs}) == len(songs)
tpl = (ROOT / "app_template.html").read_text(encoding="utf-8")
tpl = tpl.replace("/*PDF_IMPORT*/", (ROOT / "pdf_import.js").read_text(encoding="utf-8"))
tpl = tpl.replace("/*CLOUD_JS*/", (ROOT / "cloud.js").read_text(encoding="utf-8"))
# общая база: CLOUD_URL и CLOUD_KEY (publishable) — тогда сайт работает через Supabase
import os
if os.environ.get("CLOUD_URL"):
    cfg = json.dumps({"url": os.environ["CLOUD_URL"], "key": os.environ["CLOUD_KEY"]})
    tpl = tpl.replace("/*CLOUD_CONFIG*/null", cfg)
    js = os.environ.get("SUPABASE_JS", "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/dist/umd/supabase.js")
    tpl = tpl.replace("<script>\n/* ======================= данные", f'<script src="{js}"></script>\n<script>\n/* ======================= данные', 1)
    assert js in tpl
data = json.dumps(songs, ensure_ascii=False).replace("</", "<\\/")
if os.environ.get("CLOUD_URL") and not os.environ.get("CLOUD_EMBED"):
    data = "[]"  # закрытый сайт: песни приходят только из базы и только участникам
dst.write_text(tpl.replace("/*SONGS_JSON*/[]", data), encoding="utf-8")
(dst.parent / "songs.json").write_text(json.dumps(songs, ensure_ascii=False, indent=2), encoding="utf-8")
print("ok", len(songs), "songs ->", dst)
