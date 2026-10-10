"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const CRITERIA_LIST_FIELDS = [
  "keywordsAny",
  "keywordsAll",
  "exclude",
  "categoriesAny",
  "regionsAny",
  "procedureTypesAny",
  "organizersExclude",
  "classifierCodes",
  "docKeywordsAny",
  "docKeywordsAll",
  "docExclude",
];

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/* ---------- Tabs ---------- */
$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.remove("active"));
    $$(".view").forEach((v) => v.classList.remove("active"));
    tab.classList.add("active");
    $("#view-" + tab.dataset.tab).classList.add("active");
    if (tab.dataset.tab === "tenders") {
      loadStats();
      loadTenders().catch(() => {});
    }
    if (tab.dataset.tab === "criteria") loadCriteria();
    if (tab.dataset.tab === "settings") {
      loadSettings();
      pollScheduler();
    }
  });
});

/* ---------- Stats ---------- */
async function loadStats() {
  try {
    const s = await api("/api/stats");
    $("#stats").textContent = `Тендеров: ${s.total} · с карточкой: ${s.withCard} · ${s.authenticated ? "авторизован" : "гость"}`;
  } catch (e) {
    $("#stats").textContent = "—";
  }
}

/* ---------- Tenders list ---------- */
let currentTenders = [];
let selectedId = null;

async function loadTenders() {
  const params = new URLSearchParams();
  const q = $("#f-q").value.trim();
  if (q) params.set("q", q);
  params.set("status", $("#f-status").value);
  params.set("sort", $("#f-sort").value);
  if ($("#f-matched").checked) params.set("matched", "true");
  if ($("#f-card").checked) params.set("hasCard", "true");

  const data = await api("/api/tenders?" + params.toString());
  currentTenders = data.tenders;
  renderRows();
}

function renderRows() {
  const tbody = $("#rows");
  tbody.innerHTML = "";
  $("#empty").classList.toggle("hidden", currentTenders.length > 0);

  for (const t of currentTenders) {
    const tr = document.createElement("tr");
    tr.dataset.id = t.id;
    if (t.id === selectedId) tr.classList.add("selected");
    tr.innerHTML = `
      <td><span class="score ${t._matched ? "hit" : ""}">${t._score}</span></td>
      <td class="nowrap muted">${esc(t.procedure_type || "—")}</td>
      <td class="title">${t._matched ? '<span class="badge-match">★ отобран</span> ' : ""}<b>${esc(t.title || "—")}</b></td>
      <td>${esc(t.organizer_name || "—")}</td>
      <td>${esc(t.region || "—")}</td>
      <td class="nowrap">${esc(t.price || "—")}</td>
      <td class="nowrap muted">${fmtDate(t.end_at || t.actual_until)}</td>`;
    tr.addEventListener("click", () => selectTender(t.id));
    tbody.appendChild(tr);
  }
}

async function selectTender(id) {
  selectedId = id;
  $$("#rows tr").forEach((tr) => tr.classList.toggle("selected", tr.dataset.id === id));
  const d = await api("/api/tenders/" + id);
  renderDetail(d);
}

function renderDetail(d) {
  const t = d.tender;
  const ev = d.evaluation;
  const rows = [
    ["Организатор", t.organizer_name],
    ["Заказчик", t.customer_name],
    ["Регион", t.region],
    ["Категория", t.category],
    ["Цена", t.price],
    ["Валюта", t.currency],
    ["Участники", t.participants],
    ["Опубликовано", fmtDate(t.published_at)],
    ["Окончание", fmtDate(t.end_at || t.actual_until)],
    ["Условия оплаты", t.payment_terms],
    ["Условия поставки", t.delivery_terms],
  ].filter(([, v]) => v);

  const infoExtra = Object.entries(d.infoRows || {})
    .filter(([k]) => !["Тег", "Заказчик"].includes(k))
    .slice(0, 25);

  const docLen = (t.doc_text || "").length;
  const docHtml = t.doc_indexed_at
    ? `<p class="muted">Документация проанализирована: ${docLen.toLocaleString("ru-RU")} символов текста.</p>`
    : `<p class="muted">Документация не проанализирована${t.requires_auth ? " (нужна авторизация)" : ""}.</p>`;

  const filesHtml = (d.files || []).length
    ? `<div class="files"><b>Документация:</b>${d.files
        .map((f) => `<a href="${f.local_path ? "/files/" + esc(f.local_path) : esc(f.url)}" target="_blank">${esc(f.name || f.url)}</a>`)
        .join("")}</div>`
    : t.requires_auth
      ? `<p class="badge-auth">Документация доступна только авторизованным пользователям площадки.</p>`
      : "";

  $("#detail").innerHTML = `
    <div class="type">${esc(t.procedure_type || "")} № ${esc(t.id)}</div>
    <h3>${esc(t.title || "—")}</h3>
    ${ev.matched ? `<div class="reasons"><b>Подходит (score ${ev.score}).</b> ${esc((ev.reasons || []).join("; "))}</div>`
      : `<div class="rejected">Не проходит по критериям${ev.rejectedBy ? ": " + esc(ev.rejectedBy) : ""}.</div>`}
    <dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    ${infoExtra.length ? `<details><summary class="muted">Доп. поля (${infoExtra.length})</summary><dl>${infoExtra
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></details>` : ""}
    ${docHtml}
    ${filesHtml}
    <div class="actions">
      <a class="btn" href="${esc(t.url)}" target="_blank">Открыть на B2B-Center</a>
      <button class="btn" id="d-fetch">${t.card_fetched_at ? "Обновить карточку" : "Загрузить карточку"}</button>
      <button class="btn primary" id="d-app">Заявка на участие</button>
    </div>
    <div id="app-form" class="hidden"></div>`;

  $("#d-fetch").addEventListener("click", async () => {
    $("#d-fetch").disabled = true;
    $("#d-fetch").textContent = "Загрузка…";
    try {
      await api("/api/card", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: t.url, downloadFiles: true }) });
      pollJob(() => selectTender(t.id));
    } catch (e) {
      alert(e.message);
      $("#d-fetch").disabled = false;
    }
  });

  $("#d-app").addEventListener("click", () => openApplication(t.id));
}

/* ---------- Application form ---------- */
function fieldInputHtml(f, idx) {
  const val = esc(f.value || "");
  const input = f.multiline
    ? `<textarea data-idx="${idx}" rows="3">${val}</textarea>`
    : `<input data-idx="${idx}" value="${val}" />`;
  const del = f.source !== "standard" ? `<button class="btn app-del" data-del="${idx}" title="Удалить поле">✕</button>` : "";
  const badge = f.source === "doc" ? `<span class="badge-doc">из документации</span>` : "";
  return `<label class="app-field">${esc(f.label)} ${badge}<div class="app-input-row">${input}${del}</div></label>`;
}

async function openApplication(tenderId) {
  const box = $("#app-form");
  box.classList.remove("hidden");
  box.innerHTML = `<p class="muted">Загрузка формы…</p>`;
  let form;
  try {
    form = await api("/api/application/" + tenderId);
  } catch (e) {
    box.innerHTML = `<p class="rejected">Ошибка: ${esc(e.message)}</p>`;
    return;
  }
  renderApplication(tenderId, form);
}

function renderApplication(tenderId, form) {
  const box = $("#app-form");
  const fields = form.fields;
  const std = fields.map((f, i) => ({ f, i })).filter((x) => x.f.source === "standard");
  const docReq = fields.map((f, i) => ({ f, i })).filter((x) => x.f.source === "doc");
  const custom = fields.map((f, i) => ({ f, i })).filter((x) => x.f.source === "custom");

  box.innerHTML = `
    <hr />
    <h3>Заявка на участие</h3>
    <p class="hint">Заполните поля — из них будет собран PDF-документ. Черновик сохраняется по кнопке. Пустые поля в PDF не попадают.</p>
    <h4>Сведения об участнике и предложение</h4>
    ${std.map(({ f, i }) => fieldInputHtml(f, i)).join("")}
    ${docReq.length ? `<h4>Требования заказчика (найдены в документации)</h4>
      <p class="hint">Проверьте формулировки по оригинальной документации — извлечение автоматическое.</p>
      ${docReq.map(({ f, i }) => fieldInputHtml(f, i)).join("")}` : `<p class="muted">Требования из документации не извлечены${form.updatedAt ? "" : " (документация не проанализирована или пуста)"}.</p>`}
    ${custom.length ? `<h4>Дополнительные поля</h4>${custom.map(({ f, i }) => fieldInputHtml(f, i)).join("")}` : ""}
    <div class="actions">
      <button class="btn" id="app-add">+ своё поле</button>
      <button class="btn" id="app-save">Сохранить черновик</button>
      <button class="btn primary" id="app-pdf">Сформировать PDF</button>
      ${form.pdfPath ? `<a class="btn" href="/files/${esc(form.pdfPath)}" target="_blank">Скачать PDF</a>` : ""}
      <span class="muted" id="app-status">${form.updatedAt ? "черновик от " + fmtDate(form.updatedAt) : ""}</span>
    </div>`;

  const collect = () => {
    box.querySelectorAll("[data-idx]").forEach((el) => {
      fields[Number(el.dataset.idx)].value = el.value;
    });
    return fields;
  };

  box.querySelectorAll(".app-del").forEach((btn) =>
    btn.addEventListener("click", () => {
      collect();
      fields.splice(Number(btn.dataset.del), 1);
      renderApplication(tenderId, form);
    }),
  );

  $("#app-add").addEventListener("click", () => {
    const label = prompt("Название поля (что запрашивает заказчик):");
    if (!label) return;
    collect();
    fields.push({ id: "c" + Date.now(), label, value: "", source: "custom", multiline: true });
    renderApplication(tenderId, form);
  });

  $("#app-save").addEventListener("click", async () => {
    try {
      const saved = await api("/api/application/" + tenderId, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: collect() }),
      });
      renderApplication(tenderId, saved);
      $("#app-status").textContent = "Черновик сохранён";
    } catch (e) { alert(e.message); }
  });

  $("#app-pdf").addEventListener("click", async () => {
    $("#app-pdf").disabled = true;
    $("#app-status").textContent = "Формирование PDF…";
    try {
      const r = await api("/api/application/" + tenderId + "/pdf", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: collect() }),
      });
      renderApplication(tenderId, r.form);
      $("#app-status").textContent = "PDF готов";
      window.open(r.pdfUrl, "_blank");
    } catch (e) {
      alert(e.message);
      $("#app-pdf").disabled = false;
    }
  });
}

$("#f-refresh").addEventListener("click", () => loadTenders().catch((e) => alert(e.message)));
["#f-status", "#f-sort", "#f-matched", "#f-card"].forEach((s) => $(s).addEventListener("change", () => loadTenders()));
let qTimer;
$("#f-q").addEventListener("input", () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => loadTenders(), 350);
});

/* ---------- Criteria ---------- */
async function loadCriteria() {
  const { criteria } = await api("/api/criteria");
  for (const f of CRITERIA_LIST_FIELDS) $("#c-" + f).value = (criteria[f] || []).join("\n");
  $("#c-priceMin").value = criteria.priceMin ?? "";
  $("#c-priceMax").value = criteria.priceMax ?? "";
  $("#c-minDaysUntilEnd").value = criteria.minDaysUntilEnd ?? "";
  $("#c-minScore").value = criteria.minScore ?? "";
  // prefill scrape keywords too
  if (!$("#s-keywords").value.trim()) $("#s-keywords").value = (criteria.keywordsAny || []).join(", ");
}

function linesToArr(id) {
  return $("#" + id).value.split("\n").map((s) => s.trim()).filter(Boolean);
}

$("#c-save").addEventListener("click", async () => {
  const body = {};
  for (const f of CRITERIA_LIST_FIELDS) body[f] = linesToArr("c-" + f);
  const num = (id) => ($("#" + id).value === "" ? undefined : Number($("#" + id).value));
  body.priceMin = num("c-priceMin");
  body.priceMax = num("c-priceMax");
  body.minDaysUntilEnd = num("c-minDaysUntilEnd");
  body.minScore = num("c-minScore") ?? 1;
  try {
    await api("/api/criteria", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    $("#c-status").textContent = "Сохранено ✓";
    setTimeout(() => ($("#c-status").textContent = ""), 2500);
    loadTenders().catch(() => {});
  } catch (e) {
    $("#c-status").textContent = "Ошибка: " + e.message;
  }
});
$("#c-reload").addEventListener("click", () => loadCriteria());

/* ---------- Scrape / Job ---------- */
let jobPoll = null;

function renderJob(job, onDone) {
  const st = $("#job-status");
  st.className = "job-status " + (job.status || "");
  const map = { running: "Выполняется…", done: "Завершено", error: "Ошибка", idle: "Нет активных задач" };
  let text = `${job.type ? "[" + job.type + "] " : ""}${map[job.status] || job.status}`;
  if (job.status === "done" && job.result) text += " — " + JSON.stringify(job.result);
  st.textContent = text;
  $("#job-log").textContent = (job.log || []).join("\n");
  $("#job-log").scrollTop = $("#job-log").scrollHeight;

  if (job.status !== "running" && jobPoll) {
    clearInterval(jobPoll);
    jobPoll = null;
    setButtonsDisabled(false);
    loadStats();
    loadTenders().catch(() => {});
    if (onDone) onDone();
  }
}

function pollJob(onDone) {
  setButtonsDisabled(true);
  if (jobPoll) clearInterval(jobPoll);
  const tick = async () => {
    try {
      renderJob(await api("/api/job"), onDone);
    } catch (e) {
      /* ignore */
    }
  };
  tick();
  jobPoll = setInterval(tick, 1500);
}

function setButtonsDisabled(v) {
  ["#s-run", "#e-run"].forEach((s) => ($(s).disabled = v));
}

$("#s-run").addEventListener("click", async () => {
  const body = {
    keywords: $("#s-keywords").value,
    status: $("#s-status").value,
    trade: $("#s-trade").value,
    dateFrom: $("#s-dateFrom").value.trim() || undefined,
    dateTo: $("#s-dateTo").value.trim() || undefined,
  };
  try {
    await api("/api/scrape", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    pollJob();
  } catch (e) {
    alert(e.message);
  }
});

$("#e-run").addEventListener("click", async () => {
  const body = { limit: Number($("#e-limit").value) || 20, downloadFiles: $("#e-files").checked };
  try {
    await api("/api/enrich", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    pollJob();
  } catch (e) {
    alert(e.message);
  }
});

/* ---------- Settings / Auth ---------- */
function addCookieRow(name = "", value = "") {
  const row = document.createElement("div");
  row.className = "cookie-row";
  row.innerHTML = `
    <input class="ck-name" placeholder="имя (напр. PHPSESSID)" />
    <input class="ck-value" placeholder="значение" />
    <button class="btn ck-del" title="Удалить">✕</button>`;
  row.querySelector(".ck-name").value = name;
  row.querySelector(".ck-value").value = value;
  row.querySelector(".ck-del").addEventListener("click", () => row.remove());
  $("#cookie-rows").appendChild(row);
}

function getCookieRows() {
  return $$("#cookie-rows .cookie-row")
    .map((r) => ({
      name: r.querySelector(".ck-name").value.trim(),
      value: r.querySelector(".ck-value").value.trim(),
    }))
    .filter((p) => p.name && p.value);
}

function setCookieRows(pairs) {
  $("#cookie-rows").innerHTML = "";
  if (pairs && pairs.length) pairs.forEach((p) => addCookieRow(p.name, p.value));
  else addCookieRow("PHPSESSID", "");
}

async function loadSettings() {
  const s = await api("/api/settings");
  setCookieRows(s.authCookiePairs);
  $("#set-cookie-state").textContent = s.authCookieSet
    ? `Сохранено кук: ${s.authCookiePairs.length}. Работа в авторизованном режиме.`
    : "Куки не заданы — работа в гостевом режиме.";
  $("#set-interval").value = s.pollIntervalMinutes;
  $("#set-enrichPerCycle").value = s.enrichPerCycle;
  $("#set-autoEnrich").checked = s.autoEnrich;
  $("#set-autoDownloadDocs").checked = s.autoDownloadDocs;
}

$("#cookie-add").addEventListener("click", () => addCookieRow());
$("#cookie-parse").addEventListener("click", async () => {
  const raw = $("#set-cookie-raw").value;
  if (!raw.trim()) {
    alert("Вставьте куки в поле выше.");
    return;
  }
  try {
    const { pairs } = await api("/api/settings/parse-cookies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (pairs && pairs.length) {
      setCookieRows(pairs);
      $("#set-cookie-raw").value = "";
      $("#set-cookie-state").textContent = `Распознано кук B2B-Center: ${pairs.length}. Проверьте и нажмите «Сохранить».`;
    } else {
      alert("Не нашёл куки домена b2b-center.ru. Проверьте, что скопированы строки именно из раздела Cookies для www.b2b-center.ru.");
    }
  } catch (e) {
    alert(e.message);
  }
});

$("#set-save").addEventListener("click", async () => {
  try {
    await saveSettings();
    await loadSettings();
    loadStats();
  } catch (e) {
    alert(e.message);
  }
});

async function saveSettings() {
  const body = {
    pollIntervalMinutes: Number($("#set-interval").value) || 30,
    enrichPerCycle: Number($("#set-enrichPerCycle").value) || 50,
    autoEnrich: $("#set-autoEnrich").checked,
    autoDownloadDocs: $("#set-autoDownloadDocs").checked,
    authCookiePairs: getCookieRows(),
  };
  await api("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

$("#set-check").addEventListener("click", async () => {
  $("#set-check-status").style.color = "";
  $("#set-check-status").textContent = "Сохранение и проверка…";
  try {
    await saveSettings();
    await loadSettings();
    loadStats();
    const r = await api("/api/settings/check-auth", { method: "POST" });
    $("#set-check-status").textContent = r.authenticated
      ? `Авторизован (user_id ${r.userId}) ✓`
      : `Не авторизован${r.note ? " — " + r.note : ""}`;
    $("#set-check-status").style.color = r.authenticated ? "var(--good)" : "#99312a";
  } catch (e) {
    $("#set-check-status").textContent = "Ошибка: " + e.message;
  }
});

/* ---------- Scheduler ---------- */
let schedPoll = null;
let lastSchedCycles = null;

function renderScheduler(st) {
  // When a cycle finishes (cycle counter advanced), refresh stats and the list.
  if (lastSchedCycles !== null && st.cycles > lastSchedCycles) {
    loadStats();
    loadTenders().catch(() => {});
  }
  lastSchedCycles = st.cycles;
  renderSchedulerStatus(st);
}

function renderSchedulerStatus(st) {
  const el = $("#sch-status");
  el.className = "job-status " + (st.running ? "running" : st.enabled ? "done" : "");
  const parts = [st.enabled ? "Включён" : "Остановлен"];
  if (st.running) parts.push("выполняется цикл…");
  if (st.intervalMinutes) parts.push(`интервал ${st.intervalMinutes} мин`);
  if (st.lastRunAt) parts.push(`последний запуск ${fmtDate(st.lastRunAt)}`);
  if (st.nextRunAt && st.enabled && !st.running) parts.push(`следующий ~${fmtDate(st.nextRunAt)}`);
  if (st.cycles) parts.push(`циклов: ${st.cycles}`);
  if (st.lastResult) parts.push(`совпадений: ${st.lastResult.matches} (новых: ${st.lastResult.newMatches.length})`);
  el.textContent = parts.join(" · ");
  $("#sch-log").textContent = (st.log || []).join("\n");
  $("#sch-log").scrollTop = $("#sch-log").scrollHeight;

  if (!st.enabled && !st.running && schedPoll) {
    clearInterval(schedPoll);
    schedPoll = null;
  }
}

async function pollScheduler() {
  const tick = async () => {
    try {
      renderScheduler(await api("/api/scheduler"));
    } catch (e) {}
  };
  await tick();
  if (!schedPoll) schedPoll = setInterval(tick, 3000);
}

$("#sch-start").addEventListener("click", async () => {
  try {
    await api("/api/scheduler/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intervalMinutes: Number($("#set-interval").value) || 30 }) });
    pollScheduler();
  } catch (e) {
    alert(e.message);
  }
});
$("#sch-stop").addEventListener("click", async () => {
  try {
    renderScheduler(await api("/api/scheduler/stop", { method: "POST" }));
  } catch (e) {
    alert(e.message);
  }
});
$("#sch-run").addEventListener("click", async () => {
  try {
    await api("/api/scheduler/run-now", { method: "POST" });
    pollJob(() => loadTenders().catch(() => {}));
    pollScheduler();
  } catch (e) {
    alert(e.message);
  }
});

/* ---------- Init ---------- */
(async function init() {
  await loadStats();
  await loadTenders().catch((e) => console.warn(e));
  // Resume polling if a job is already running (e.g. page reload during scrape).
  try {
    const job = await api("/api/job");
    if (job.status === "running") pollJob();
  } catch (e) {}
})();
