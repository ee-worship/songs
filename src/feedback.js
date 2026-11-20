/* ======================= голоса и комментарии =======================
   👍/👎 — для песен «На рассмотрении» (один голос на человека), комментарии — к любой песне. */
cloud.votes = {};   // song_id -> { up: [имена], down: [имена], mine: -1|0|1 }
cloud.ccount = {};  // song_id -> число комментариев
let MY_VOTER = CLOUD ? store.get("cloud:voter", null) : null;
const FB_ON = () => !!CLOUD && isMember();

async function ensureVoter() {
  if (MY_VOTER || !db || !isMember()) return;
  const { data } = await db.rpc("my_voter");
  if (data) { MY_VOTER = data; store.set("cloud:voter", data); }
}
async function loadFeedback() {
  if (!db || !isMember()) return;
  await ensureVoter();
  const [v, c] = await Promise.all([
    db.from("song_votes").select("song_id,voter,voter_name,vote").range(0, 9999),
    db.from("song_comments").select("song_id").range(0, 9999),
  ]);
  if (v.error || c.error) return;
  const votes = {};
  v.data.forEach(r => {
    const x = votes[r.song_id] ||= { up: [], down: [], mine: 0 };
    (r.vote > 0 ? x.up : x.down).push(r.voter_name || "?");
    if (r.voter === MY_VOTER) x.mine = r.vote;
  });
  const cc = {};
  c.data.forEach(r => { cc[r.song_id] = (cc[r.song_id] || 0) + 1; });
  cloud.votes = votes; cloud.ccount = cc;
}
function forgetFeedback() { cloud.votes = {}; cloud.ccount = {}; MY_VOTER = null; store.set("cloud:voter", null); }

// значки в списке песен
function feedbackChips(s) {
  if (!FB_ON()) return "";
  const v = cloud.votes[s.id], n = cloud.ccount[s.id] || 0;
  const votes = v && (v.up.length || v.down.length) ? `<span class="pill fb-pill" title="Голоса">👍${v.up.length} 👎${v.down.length}</span>` : "";
  return votes + (n ? `<span class="pill fb-pill" title="Комментарии">💬${n}</span>` : "");
}

// блок голосования (под названием песни «На рассмотрении»)
function votesHtml(song) {
  const v = cloud.votes[song.id] || { up: [], down: [], mine: 0 };
  const names = [v.up.length ? "За: " + v.up.map(esc).join(", ") : "", v.down.length ? "Против: " + v.down.map(esc).join(", ") : ""].filter(Boolean).join(" · ");
  return `<button class="vote ${v.mine > 0 ? "on" : ""}" data-vote="1" title="Взять в песенник">👍 <b>${v.up.length}</b></button>
    <button class="vote ${v.mine < 0 ? "on down" : ""}" data-vote="-1" title="Не брать">👎 <b>${v.down.length}</b></button>
    <span class="muted fb-names">${names || "Пока никто не голосовал — как вам песня?"}</span>`;
}
function feedbackSectionHtml(song) {
  if (!FB_ON()) return "";
  return `<section class="fb" id="fb">
      <div class="fb-h">💬 Комментарии</div>
      <div id="fbList" class="muted">Загружаю…</div>
      <div class="fb-new"><textarea id="fbText" rows="2" maxlength="1000" placeholder="Написать комментарий…" dir="auto"></textarea>
        <button class="btn primary" id="fbSend">Отправить</button></div>
    </section>`;
}
async function loadComments(song) {
  const box = document.getElementById("fbList"); if (!box || !db) return;
  const { data, error } = await db.from("song_comments").select("*").eq("song_id", song.id).order("created_at");
  if (error) return box.textContent = "Не удалось загрузить: " + error.message;
  cloud.ccount[song.id] = data.length;
  box.classList.toggle("muted", !data.length);
  box.innerHTML = data.length ? data.map(c => `<div class="fb-c">
      <div class="fb-meta"><b>${esc(c.author || "?")}</b> <span class="muted">${fmtWhen(c.created_at)}</span>
        ${c.voter === MY_VOTER || state.admin ? `<button class="mini-btn" data-cdel="${c.id}" title="Удалить">✕</button>` : ""}</div>
      <div class="fb-body" dir="auto">${esc(c.body).replace(/\n/g, "<br>")}</div></div>`).join("")
    : "Комментариев пока нет.";
  box.querySelectorAll("[data-cdel]").forEach(b => b.onclick = () => confirmDialog("Удалить комментарий?", "Удалить", async () => {
    const { error } = await db.from("song_comments").delete().eq("id", b.dataset.cdel);
    if (error) return toast("Не получилось: " + error.message);
    loadComments(song);
  }));
}
function bindFeedback(song) {
  if (!FB_ON()) return;
  bindFeedbackVotesOnly(song);
  loadComments(song);
  const send = document.getElementById("fbSend"), ta = document.getElementById("fbText");
  if (send) send.onclick = async () => {
    const t = ta.value.trim(); if (!t) return;
    send.disabled = true;
    const { error } = await db.rpc("add_comment", { p_song: song.id, p_body: t });
    send.disabled = false;
    if (error) return toast(/too many/.test(error.message) ? "Слишком много комментариев подряд — попробуйте позже" : "Не получилось: " + error.message);
    ta.value = ""; loadComments(song);
  };
}
// пришли чужие голоса/комментарии — обновляем только нужные кусочки, не трогая набранный текст
let fbTimer;
function onFeedbackLive() {
  clearTimeout(fbTimer);
  fbTimer = setTimeout(async () => {
    await loadFeedback();
    if (current === "song") {
      const song = songById(currentId); if (!song) return;
      const vbox = document.getElementById("fbVotes"); if (vbox) bindFeedbackVotesOnly(song);
      loadComments(song);
    } else if (current === "list") fillList();
  }, 500);
}
function bindFeedbackVotesOnly(song) {
  const vbox = document.getElementById("fbVotes"); if (!vbox) return;
  vbox.innerHTML = votesHtml(song);
  vbox.querySelectorAll("[data-vote]").forEach(b => b.onclick = async () => {
    const v = cloud.votes[song.id] ||= { up: [], down: [], mine: 0 };
    const want = +b.dataset.vote === v.mine ? 0 : +b.dataset.vote;
    const { error } = await db.rpc("set_vote", { p_song: song.id, p_vote: want });
    if (error) return toast("Не получилось: " + error.message);
    await loadFeedback(); bindFeedbackVotesOnly(song);
  });
}
