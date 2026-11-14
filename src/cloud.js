/* ======================= общая база (Supabase) =======================
   Песни и сет-листы хранятся в Supabase. Копия лежит в браузере, поэтому сайт
   открывается сразу и работает при плохом интернете; изменения без связи
   ждут в очереди и отправляются, когда связь появится. */
const ROW_DEFAULTS = { title_alt: "", original: "", key: "", play_shift: 0, capo: 0, notes: "", lang: "ru", lyrics: "", chord_chart: "", translit: [], tags: [], links: [], status: "proposed", review: [] };
let db = null, ME = null;
const cloud = {
  songs: null, sets: null, queue: [], online: true, syncing: false, lastFetch: 0, ready: false, pending: 0,
};
if (CLOUD) {
  cloud.songs = store.get("cloud:songs", null);
  cloud.sets = store.get("cloud:sets", null);
  cloud.queue = store.get("cloud:queue", []);
  ME = store.get("cloud:me", null);
  state.admin = ME?.role === "admin";
}
const isMember = () => !!ME && ME.role !== "pending";
const canEdit = () => !CLOUD || isMember();
function needEdit() {
  if (canEdit()) return true;
  modal(`<h3>Только для команды</h3>
    <div class="muted" style="font-size:14px">Смотреть, искать и петь может любой. Добавлять и править песни и сет-листы — участники команды.
    Попросите у руководителя ссылку-приглашение и откройте её на этом устройстве.</div>
    <div class="actions"><button class="btn primary" data-x>Понятно</button></div>`, (m, close) => m.querySelector("[data-x]").onclick = close);
  return false;
}
const clone = o => JSON.parse(JSON.stringify(o));
function songRow(s) {
  const r = { id: s.id };
  for (const f of FIELDS) if (f !== "id" && f !== "updated_at") r[f] = s[f] ?? ROW_DEFAULTS[f] ?? "";
  r.play_shift = r.play_shift | 0; r.capo = r.capo | 0;
  if (!STATUSES.some(x => x[0] === r.status)) r.status = "proposed";
  for (const f of ["translit", "tags", "links", "review"]) if (!Array.isArray(r[f])) r[f] = [];
  r.tags = r.tags.map(String);
  r.deleted_at = s.deleted_at || null;
  return r;
}
const setRow = s => ({ id: s.id, name: s.name || "", date: s.date || "", items: s.items || [], notes: s.notes || "" });
const setFromRow = r => ({ id: r.id, name: r.name, date: r.date, items: r.items || [], notes: r.notes || "", updated_at: r.updated_at, updated_by_name: r.updated_by_name });

function persistCloud() { store.set("cloud:songs", cloud.songs); store.set("cloud:sets", cloud.sets); store.set("cloud:queue", cloud.queue); }
function cacheUpsert(t, row) {
  const arr = t === "songs" ? (cloud.songs ||= clone(BASE_SONGS).map(songRow)) : (cloud.sets ||= []);
  const item = t === "songs" ? row : setFromRow(row);
  const i = arr.findIndex(x => x.id === row.id);
  if (i >= 0) arr[i] = { ...arr[i], ...item }; else arr.push(item);
}
function cacheRemove(t, id) {
  if (t === "songs" && cloud.songs) cloud.songs = cloud.songs.filter(x => x.id !== id);
  if (t === "setlists" && cloud.sets) cloud.sets = cloud.sets.filter(x => x.id !== id);
}
function applyOp(op) {
  if (op.op === "upsert") cacheUpsert(op.t, { ...op.row, updated_at: op.row.updated_at || new Date().toISOString() });
  else if (op.op === "delete") cacheRemove(op.t, op.id);
}
// изменения: последнее по одной и той же песне/сет-листу заменяет предыдущее
function queuePush(op) {
  cloud.queue = cloud.queue.filter(q => !(q.t === op.t && (q.row?.id || q.id) === (op.row?.id || op.id)));
  cloud.queue.push(op);
  applyOp(op);
  persistCloud();
  clearTimeout(queuePush.timer);
  queuePush.timer = setTimeout(flushQueue, 250);
  updateSyncNote();
}
const pendingIds = t => new Set(cloud.queue.filter(q => q.t === t).map(q => q.row?.id || q.id));

let needRefetch = false;
async function flushQueue() {
  if (!db || cloud.syncing || !cloud.queue.length) return;
  cloud.syncing = true;
  try {
    while (cloud.queue.length) {
      const op = cloud.queue[0];
      const q = db.from(op.t);
      const res = op.op === "upsert" ? await q.upsert(op.row) : await q.delete().eq("id", op.id);
      if (res.error) {
        const st = res.status | 0;
        if (st >= 400 && st < 500) {
          // база отказала (нет прав или неверные данные) — такое изменение не пройдёт и потом
          console.warn("sync rejected", op, res.error);
          toast("Не сохранилось: " + (st === 401 || st === 403 || res.error.code === "42501" ? "нет прав на изменение" : res.error.message));
          cloud.queue.shift(); persistCloud(); needRefetch = true;
          if (st === 401 || st === 403) refreshMe();
          continue;
        }
        cloud.online = false; break; // нет связи — попробуем позже
      }
      cloud.online = true;
      cloud.queue.shift(); persistCloud();
    }
  } finally { cloud.syncing = false; updateSyncNote(); }
  if (needRefetch) { needRefetch = false; cloudFetch(); }
}

async function cloudFetch() {
  if (!db || !isMember()) return false;
  const [a, b] = await Promise.all([
    db.from("songs").select("*").range(0, 4999),
    db.from("setlists").select("*").range(0, 4999),
  ]);
  if (a.error || b.error) { cloud.online = false; updateSyncNote(); return false; }
  cloud.online = true; cloud.lastFetch = Date.now();
  cloud.songs = a.data; cloud.sets = b.data.map(setFromRow);
  cloud.queue.forEach(applyOp); // неотправленные правки поверх свежих данных
  if (state.admin) {
    const c = await db.from("members").select("user_id", { count: "exact", head: true }).eq("role", "pending");
    if (!c.error) cloud.pending = c.count || 0;
  }
  persistCloud(); loadSongs(); cloud.ready = true;
  refreshView(); return true;
}

function onLive(t, p) {
  const id = (p.new && p.new.id) || (p.old && p.old.id);
  if (!id || pendingIds(t).has(id)) return;
  if (p.eventType === "DELETE") cacheRemove(t, id); else cacheUpsert(t, p.new);
  persistCloud(); loadSongs();
  clearTimeout(onLive.timer); onLive.timer = setTimeout(refreshView, 400);
}

// без приглашения сайт закрыт: показываем только эту страницу
function renderGate() {
  document.title = "Песни команды";
  const pending = ME?.role === "pending";
  app.innerHTML = `<main class="wrap gate">
    <div class="gate-box">
      <div class="gate-ico">${pending ? "⏳" : "🎵"}</div>
      <h2>Песни команды прославления</h2>
      ${pending ? `<p><b>${esc(ME.name)}</b>, ваша заявка отправлена.</p>
        <p class="muted">Как только руководитель её одобрит, песни откроются здесь сами — страницу можно не закрывать.</p>
        <button class="btn" id="gateCheck">Проверить</button>`
      : `<p class="muted">Сайт закрытый. Чтобы открыть песни, нужна ссылка-приглашение — попросите её у руководителя команды и откройте на этом устройстве.</p>
        <p class="muted" style="font-size:13px">Уже входили раньше? Если вы очистили браузер или открыли сайт на новом устройстве, просто откройте ссылку-приглашение ещё раз.</p>`}
      <div style="margin-top:18px;display:flex;gap:8px;justify-content:center;align-items:center">
        <button class="icon-btn" data-theme-btn title="Тема">${state.theme === "dark" ? ICON.sun : ICON.moon}</button>
      </div>
      <div class="admin-link" style="margin-top:22px"><button id="adminLogin">Вход для админа</button></div>
    </div></main>`;
  document.querySelectorAll("[data-theme-btn]").forEach(b => b.onclick = toggleTheme);
  document.getElementById("adminLogin").onclick = adminLoginDialog;
  document.getElementById("gateCheck")?.addEventListener("click", async () => { await refreshMe(); if (ME?.role === "pending") toast("Пока не одобрено"); });
}
function adminLoginDialog() {
  modal(`<h3>Вход для админа</h3>
    <div class="field"><label>Почта</label><input id="al_email" type="email" autocomplete="username"></div>
    <div class="field"><label>Пароль</label><input id="al_pass" type="password" autocomplete="current-password"></div>
    <div class="actions"><button class="btn" data-x>Отмена</button><button class="btn primary" data-ok>Войти</button></div>`, (m, close) => {
    const em = m.querySelector("#al_email"), pw = m.querySelector("#al_pass"), okBtn = m.querySelector("[data-ok]");
    setTimeout(() => em.focus(), 50);
    m.querySelector("[data-x]").onclick = close;
    const ok = async () => {
      if (!db) return toast("Нет связи с базой");
      if (!em.value.trim() || !pw.value) return toast("Введите почту и пароль");
      okBtn.disabled = true;
      try {
        const { error } = await db.auth.signInWithPassword({ email: em.value.trim(), password: pw.value });
        if (error) return toast(/invalid/i.test(error.message) ? "Неверная почта или пароль" : "Не получилось: " + error.message);
        await refreshMe();
        if (!isMember()) { await db.auth.signOut(); return toast("У этого аккаунта нет доступа"); }
        close(); toast(`Здравствуйте, ${ME.name}!`);
        await cloudFetch(); show(currentId);
      } finally { okBtn.disabled = false; }
    };
    okBtn.onclick = ok;
    pw.onkeydown = e => { if (e.key === "Enter") ok(); };
  });
}
function forgetCloudData() {
  cloud.songs = null; cloud.sets = null; cloud.queue = [];
  persistCloud(); loadSongs();
}

let refreshPending = false;
function refreshView() {
  if (current === "edit" || document.querySelector(".modal-bg") || proj || document.getElementById("stage") || openMenu) { refreshPending = true; return; }
  refreshPending = false;
  if (!isMember()) { show(""); return; }
  const y = scrollY;
  if (current === "list") {
    if (document.activeElement?.id === "q") { fillList(); const ab = document.getElementById("adminBtn"); if (ab) ab.innerHTML = teamBtnLabel(); updateSyncNote(); }
    else { renderList(); scrollTo(0, y); }
  }
  else { show(currentId, { keepCtx: !!state.ctx }); scrollTo(0, y); }
}
setInterval(() => { if (refreshPending) refreshView(); }, 1500);

async function refreshMe() {
  const { data, error, status } = await db.rpc("whoami");
  if (error && !(status >= 400 && status < 500)) return; // нет связи — оставляем как было
  const was = JSON.stringify(ME), wasMember = isMember();
  ME = error ? null : data || null;
  state.admin = ME?.role === "admin";
  store.set("cloud:me", ME);
  if (!isMember()) forgetCloudData();
  if (isMember() && !wasMember) { await cloudFetch(); toast("Доступ открыт — добро пожаловать!"); }
  if (JSON.stringify(ME) !== was) refreshView();
}

async function cloudInit() {
  if (!window.supabase) { cloud.online = false; updateSyncNote(); return; }
  db = window.supabase.createClient(CLOUD.url, CLOUD.key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "songs-auth" } });
  const { data: { session } } = await db.auth.getSession();
  if (session) await refreshMe(); else if (ME) { ME = null; state.admin = false; store.set("cloud:me", null); forgetCloudData(); }
  if (!isMember()) show(currentId);
  setInterval(() => { if (ME?.role === "pending" && !document.hidden) refreshMe(); }, 15000);
  const code = new URLSearchParams(location.search).get("join");
  if (code) joinDialog(code);
  await cloudFetch();
  flushQueue();
  db.channel("live")
    .on("postgres_changes", { event: "*", schema: "public", table: "songs" }, p => onLive("songs", p))
    .on("postgres_changes", { event: "*", schema: "public", table: "setlists" }, p => onLive("setlists", p))
    .subscribe();
  setInterval(flushQueue, 20000);
  addEventListener("online", () => { flushQueue(); cloudFetch(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - cloud.lastFetch > 60000) { cloudFetch(); flushQueue(); if (ME) refreshMe(); } });
}

function cleanJoinUrl() { try { history.replaceState(null, "", location.pathname + location.hash); } catch {} }
function joinDialog(code) {
  if (ME && ME.role === "admin") { cleanJoinUrl(); return toast("Вы уже в команде как админ"); }
  modal(`<h3>Приглашение в команду</h3>
    <div class="muted" style="font-size:14px">Вы сможете добавлять и править песни и сет-листы с этого устройства. Ваше имя будет видно в истории изменений.</div>
    <div class="field" style="margin-top:12px"><label>Как вас зовут?</label><input id="jn" maxlength="60" autocomplete="name" placeholder="Имя" value="${esc(ME?.name || "")}"></div>
    <div class="actions"><button class="btn" data-x>Не сейчас</button><button class="btn primary" data-ok>Войти в команду</button></div>`, (m, close) => {
    const inp = m.querySelector("#jn"), okBtn = m.querySelector("[data-ok]");
    setTimeout(() => inp.focus(), 50);
    m.querySelector("[data-x]").onclick = () => { cleanJoinUrl(); close(); };
    const ok = async () => {
      const name = inp.value.trim(); if (!name) return toast("Напишите имя");
      if (!db) return toast("Нет связи с базой — попробуйте позже");
      okBtn.disabled = true; okBtn.textContent = "Подключаю…";
      try {
        let { data: { session } } = await db.auth.getSession();
        if (!session) {
          const r = await db.auth.signInAnonymously();
          if (r.error) {
            const msg = /anonymous/i.test(r.error.message) ? "В Supabase не включён вход по ссылке (Anonymous sign-ins)" : "Не получилось войти: " + r.error.message;
            return toast(msg);
          }
        }
        const { data, error } = await db.rpc("join_team", { p_code: code, p_name: name });
        if (error) return toast(/invalid invite/.test(error.message) ? "Ссылка устарела — попросите у руководителя новую" : "Ошибка: " + error.message);
        ME = data; state.admin = ME?.role === "admin"; store.set("cloud:me", ME);
        cleanJoinUrl(); close();
        if (ME?.role === "pending") { toast("Заявка отправлена — ждите одобрения"); show(""); return; }
        toast(`Добро пожаловать, ${name}!${state.admin ? " Вы админ." : ""}`);
        await cloudFetch(); show(currentId);
      } finally { okBtn.disabled = false; okBtn.textContent = "Войти в команду"; }
    };
    okBtn.onclick = ok;
    inp.onkeydown = e => { if (e.key === "Enter") ok(); };
  });
}

function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }) + " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

// «Команда»: кто в команде, ссылки-приглашения, удалённые песни
async function teamDialog() {
  if (!ME) {
    return modal(`<h3>Вход для команды</h3>
      <div class="muted" style="font-size:14px">Править песни могут участники команды. Чтобы войти, откройте на этом устройстве ссылку-приглашение от руководителя.</div>
      <div class="actions"><button class="btn primary" data-x>Понятно</button></div>`, (m, close) => m.querySelector("[data-x]").onclick = close);
  }
  const base = location.origin + location.pathname;
  const myId = db ? (await db.auth.getSession()).data.session?.user?.id : null;
  const deleted = (state.admin ? cloud.songs || [] : []).filter(s => s.deleted_at).sort((a, b) => (b.deleted_at || "").localeCompare(a.deleted_at || ""));
  modal(`<h3>Команда</h3>
    <div class="field"><label>Ваше имя</label><div style="display:flex;gap:8px"><input id="myName" maxlength="60" value="${esc(ME.name)}"><button class="btn" id="saveName">Сохранить</button></div>
      <div class="muted" style="font-size:12px;margin-top:4px">${ME.role === "admin" ? "Вы админ" : "Вы в команде: можно добавлять и править песни и сет-листы"}</div></div>
    ${state.admin ? `<div class="field"><label>Новые участники</label><div id="pendingBox" class="muted">Загружаю…</div></div>
      <div class="field"><label>Ссылка-приглашение</label><div id="invites" class="muted">Загружаю…</div></div>
      <div class="field"><label>Участники</label><div id="members" class="muted">Загружаю…</div></div>
      <div class="field"><button class="btn" id="todoBtn">📝 Что доделать в песнях</button></div>` : ""}
    ${deleted.length ? `<div class="field"><label>Удалённые песни</label>${deleted.map(s => `<div class="team-row"><span dir="auto">${esc(s.title)}</span><span class="muted">${fmtWhen(s.deleted_at || s.updated_at)}${s.updated_by_name ? " · " + esc(s.updated_by_name) : ""}</span><button class="btn" data-restore="${esc(s.id)}">Вернуть</button></div>`).join("")}</div>` : ""}
    <div class="actions"><button class="btn" id="logout">Выйти на этом устройстве</button><button class="btn primary" data-x>Готово</button></div>`, (m, close) => {
    m.querySelector("[data-x]").onclick = close;
    m.querySelector("#saveName").onclick = async () => {
      const n = m.querySelector("#myName").value.trim(); if (!n) return;
      const { error } = await db.rpc("set_my_name", { p_name: n });
      if (error) return toast("Не получилось: " + error.message);
      ME = { ...ME, name: n }; store.set("cloud:me", ME); toast("Имя сохранено");
    };
    m.querySelectorAll("[data-restore]").forEach(b => b.onclick = () => {
      const row = cloud.songs.find(s => s.id === b.dataset.restore); if (!row) return;
      queuePush({ t: "songs", op: "upsert", row: songRow({ ...row, deleted_at: null }) });
      loadSongs(); b.closest(".team-row").remove(); toast("Песня возвращена");
    });
    m.querySelector("#logout").onclick = () => confirmDialog("Выйти? Песни на этом устройстве будут скрыты; чтобы снова открыть их, понадобится ссылка-приглашение.", "Выйти", async () => {
      await db.auth.signOut(); ME = null; state.admin = false; store.set("cloud:me", null); forgetCloudData(); close(); go(""); toast("Вы вышли");
    });
    m.querySelector("#todoBtn")?.addEventListener("click", () => { close(); go("todo"); });
    if (!state.admin) return;
    const loadInvites = async () => {
      const { data, error } = await db.from("invites").select("*");
      const box = m.querySelector("#invites"); if (!box) return;
      if (error) return box.textContent = "Не удалось загрузить: " + error.message;
      const label = { editor: "Для команды", admin: "Для админов — никому не пересылайте" };
      const ed = data.find(x => x.role === "editor");
      const pb = m.querySelector("#pendingBox");
      if (pb && ed) {
        pb.innerHTML = `<label class="chk"><input type="checkbox" id="reqAppr" ${ed.require_approval ? "checked" : ""}> Одобрять новых вручную</label>
          <div class="muted" style="font-size:12px">${ed.require_approval ? "Кто откроет ссылку, сначала попадёт сюда — и получит доступ, когда вы нажмёте «Принять»." : "Сейчас любой со ссылкой сразу получает доступ."}</div>
          <div id="pendingList"></div>`;
        pb.querySelector("#reqAppr").onchange = async e => {
          const { error } = await db.rpc("set_require_approval", { p_on: e.target.checked });
          if (error) { e.target.checked = !e.target.checked; return toast("Не получилось: " + error.message); }
          toast(e.target.checked ? "Теперь новых нужно одобрять" : "Одобрение выключено"); loadInvites();
        };
        loadPending();
      }
      box.innerHTML = ["editor", "admin"].map(r => data.find(x => x.role === r && x.active)).filter(Boolean).map(inv => `
        <div class="team-inv"><div><b>${label[inv.role]}</b><span class="muted"> · входили по ней: ${inv.uses}</span></div>
          <input readonly value="${esc(base + "?join=" + inv.code)}">
          <div style="display:flex;gap:8px"><button class="btn" data-copy="${esc(base + "?join=" + inv.code)}">Скопировать</button><button class="btn" data-rot="${inv.role}">Новая ссылка</button></div></div>`).join("");
      box.querySelectorAll("[data-copy]").forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast("Ссылка скопирована"); } catch { toast("Скопируйте ссылку из поля"); } });
      box.querySelectorAll("[data-rot]").forEach(b => b.onclick = () => confirmDialog("Сделать новую ссылку? Старая перестанет работать (кто уже вошёл — останется в команде).", "Сделать", async () => {
        const { error } = await db.rpc("rotate_invite", { p_role: b.dataset.rot });
        if (error) return toast("Не получилось: " + error.message);
        toast("Новая ссылка готова"); loadInvites();
      }));
    };
    const loadPending = async () => {
      const box = m.querySelector("#pendingList"); if (!box) return;
      const { data, error } = await db.from("members").select("*").eq("role", "pending").order("joined_at");
      if (error) return box.textContent = "Не удалось загрузить: " + error.message;
      cloud.pending = data.length;
      box.innerHTML = data.length ? data.map(u => `<div class="team-row"><span><b>${esc(u.name)}</b> ждёт одобрения</span><span class="muted">${fmtWhen(u.joined_at)}</span>
        <button class="btn primary" data-appr="${u.user_id}">Принять</button><button class="btn" data-rej="${u.user_id}">Отклонить</button></div>`).join("")
        : `<div class="muted" style="font-size:13px;margin-top:6px">Заявок нет.</div>`;
      box.querySelectorAll("[data-appr]").forEach(b => b.onclick = async () => {
        const { error } = await db.from("members").update({ role: "editor" }).eq("user_id", b.dataset.appr);
        if (error) return toast("Не получилось: " + error.message);
        toast("Принят в команду"); loadPending(); loadMembers();
      });
      box.querySelectorAll("[data-rej]").forEach(b => b.onclick = async () => {
        const { error } = await db.from("members").delete().eq("user_id", b.dataset.rej);
        if (error) return toast("Не получилось: " + error.message);
        toast("Заявка отклонена"); loadPending();
      });
    };
    const loadMembers = async () => {
      const { data: all, error } = await db.from("members").select("*").order("joined_at");
      const data = (all || []).filter(u => u.role !== "pending");
      const box = m.querySelector("#members"); if (!box) return;
      if (error) return box.textContent = "Не удалось загрузить: " + error.message;
      box.innerHTML = data.map(u => `<div class="team-row"><span>${esc(u.name)}${u.role === "admin" ? ' <span class="pill">админ</span>' : ""}</span>
        <span class="muted">был(а) ${fmtWhen(u.last_seen)}</span>
        ${u.user_id === myId ? '<span class="muted">это вы</span>' : `<select data-role="${u.user_id}" class="chip"><option value="editor" ${u.role === "editor" ? "selected" : ""}>редактор</option><option value="admin" ${u.role === "admin" ? "selected" : ""}>админ</option></select><button class="btn" data-del="${u.user_id}" title="Убрать из команды">✕</button>`}</div>`).join("") || "Пока никого";
      box.querySelectorAll("[data-role]").forEach(s => s.onchange = async () => {
        const { error } = await db.from("members").update({ role: s.value }).eq("user_id", s.dataset.role);
        toast(error ? "Не получилось: " + error.message : "Роль изменена");
      });
      box.querySelectorAll("[data-del]").forEach(b => b.onclick = () => confirmDialog("Убрать из команды? Человек сможет смотреть песни, но не править. Чтобы он не вернулся по старой ссылке, сделайте новую.", "Убрать", async () => {
        const { error } = await db.from("members").delete().eq("user_id", b.dataset.del);
        if (error) return toast("Не получилось: " + error.message);
        toast("Убран из команды"); loadMembers();
      }));
    };
    loadInvites(); loadMembers();
  });
}

// история изменений песни
async function historyDialog(song) {
  if (!needEdit()) return;
  if (!db) return toast("Нет связи с базой");
  const { data, error } = await db.from("song_history").select("id,op,data,changed_at,changed_by_name").eq("song_id", song.id).order("changed_at", { ascending: false }).limit(40);
  if (error) return toast("Не удалось загрузить историю: " + error.message);
  const cur = (cloud.songs || []).find(s => s.id === song.id);
  const preview = d => esc((d.lyrics || "").replace(CHORD_TAG, "").split("\n").filter(Boolean).slice(0, 2).join(" / "));
  const diff = (a, b) => {
    const names = { title: "название", lyrics: "текст", chord_chart: "схема", key: "тональность", play_shift: "наша тональность", capo: "капо", notes: "заметки", tags: "теги", links: "ссылки", status: "этап", translit: "транскрипция", title_alt: "второе название", original: "оригинал", deleted_at: "удаление", review: "проверка" };
    return Object.keys(names).filter(k => JSON.stringify(a?.[k] ?? null) !== JSON.stringify(b?.[k] ?? null)).map(k => names[k]).join(", ");
  };
  modal(`<h3 data-wide>История: ${esc(song.title)}</h3>
    ${cur ? `<div class="hist-row"><div><b>Сейчас</b> <span class="muted">${fmtWhen(cur.updated_at)}${cur.updated_by_name ? " · " + esc(cur.updated_by_name) : ""}</span></div></div>` : ""}
    ${data.length ? data.map((h, i) => {
      const newer = i === 0 ? cur : data[i - 1].data;
      const ch = diff(h.data, newer);
      return `<div class="hist-row"><div><b>${fmtWhen(h.data.updated_at)}</b>${h.data.updated_by_name ? " · " + esc(h.data.updated_by_name) : ""}
        <div class="muted" style="font-size:13px">Потом ${h.changed_by_name ? esc(h.changed_by_name) + " " : ""}${h.op === "delete" ? "удалил(а) песню" : "изменил(а)" + (ch ? ": " + ch : "")} · ${fmtWhen(h.changed_at)}</div>
        <div class="muted" style="font-size:13px" dir="auto">${preview(h.data)}</div></div>
        <button class="btn" data-hv="${i}">Вернуть эту версию</button></div>`;
    }).join("") : `<div class="muted">Изменений пока не было — песня в исходном виде.</div>`}
    <div class="actions"><button class="btn primary" data-x>Закрыть</button></div>`, (m, close) => {
    m.querySelector("[data-x]").onclick = close;
    m.querySelectorAll("[data-hv]").forEach(b => b.onclick = () => confirmDialog("Вернуть эту версию песни? Текущая сохранится в истории.", "Вернуть", () => {
      const d = data[+b.dataset.hv].data;
      queuePush({ t: "songs", op: "upsert", row: songRow({ ...d, deleted_at: null }) });
      loadSongs(); close(); toast("Версия возвращена"); show(song.id);
    }));
  });
}

function updateSyncNote() {
  const el = document.getElementById("syncNote"); if (!el || !CLOUD) return;
  const n = cloud.queue.length;
  el.innerHTML = n ? `<div class="local-note">⏳ Не отправлено изменений: ${n}. Они сохранены на этом устройстве и уйдут в базу, когда появится связь.</div>`
    : !cloud.online ? `<div class="local-note">Нет связи с базой — показана сохранённая копия песен.</div>`
    : "";
}
