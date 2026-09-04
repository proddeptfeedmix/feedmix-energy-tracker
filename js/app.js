/* app.js - view routing + all UI wiring */
let pollTimer = null;
let currentEntryPlant = null;
let dashboardFilter = "ALL";

/* Format milliseconds as h:mm:ss for the live run timers. */
function formatElapsed(ms){
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* Ticks every second: updates any on-screen "elapsed" timer and any
 * running machine's live kWh figure, purely client-side (no DB calls),
 * so Start/Stop feels instantly real-time without hammering Supabase. */
function tickLiveTimers(){
  document.querySelectorAll(".elapsed[data-start]").forEach(el => {
    const start = new Date(el.dataset.start);
    if(isNaN(start)) return;
    el.textContent = (el.dataset.label || "") + formatElapsed(Date.now() - start);
  });
  document.querySelectorAll(".kwh[data-start]").forEach(el => {
    const start = new Date(el.dataset.start);
    if(isNaN(start)) return;
    const base = Number(el.dataset.baseKwh || 0);
    const kw = Number(el.dataset.kw || 0);
    const liveKwh = base + ((Date.now() - start) / 3600000) * kw;
    el.textContent = liveKwh.toFixed(1);
  });
  // Keep each plant's total kWh chip in sync with its machines while ticking.
  document.querySelectorAll(".plantCard").forEach(card => {
    const total = [...card.querySelectorAll(".kwh")].reduce((sum, el) => sum + (parseFloat(el.textContent) || 0), 0);
    const chip = card.querySelector(".meterChip");
    if(chip) chip.textContent = `${total.toFixed(1)} kWh`;
  });
}
setInterval(tickLiveTimers, 1000);

/* Reflects the actual Supabase realtime socket state in the header,
 * rather than a purely decorative dot — so people can trust it. */
function updateLiveIndicator(status){
  const el = document.getElementById("liveIndicator");
  const text = document.getElementById("liveText");
  if(!el || !text) return;
  el.classList.remove("offline", "connecting");
  if(status === "SUBSCRIBED"){
    text.textContent = "Live";
    el.title = "Connected — updates from any device appear instantly.";
  }else if(status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED"){
    el.classList.add("offline");
    text.textContent = "Offline";
    el.title = "Realtime connection lost — falling back to a 45s refresh. Check your internet connection.";
  }else{
    el.classList.add("connecting");
    text.textContent = "Connecting…";
    el.title = "Connecting to the live database feed…";
  }
}

function toast(msg, type = "info"){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `toast toast-${type}`;
  // Force reflow
  void t.offsetWidth;
  t.classList.add("show");
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove("show"), 3500);
}

function setLoading(isLoading, message){
  const overlay = document.getElementById("loadingOverlay");
  if(message) overlay.querySelector("p").textContent = message;
  overlay.classList.toggle("hidden", !isLoading);
}

/* Generic confirm dialog used for every destructive action (delete plant,
 * delete machine, delete user...). Returns a Promise<boolean>. */
function confirmDialog(title, message, okLabel = "Delete"){
  const modal = document.getElementById("confirmModal");
  document.getElementById("confirmTitle").textContent = title;
  document.getElementById("confirmMessage").textContent = message;
  const okBtn = document.getElementById("confirmOk");
  okBtn.textContent = okLabel;
  modal.classList.remove("hidden");
  return new Promise(resolve => {
    const cleanup = (val) => { modal.classList.add("hidden"); resolve(val); };
    okBtn.onclick = () => cleanup(true);
    document.getElementById("confirmCancel").onclick = () => cleanup(false);
    // Close on overlay click
    modal.onclick = (e) => { if(e.target === modal) cleanup(false); };
    // Close on Escape
    const escHandler = (e) => { if(e.key === "Escape") { cleanup(false); document.removeEventListener("keydown", escHandler); } };
    document.addEventListener("keydown", escHandler);
  });
}

function showView(name){
  // Fade out current view
  const currentView = document.querySelector(".view:not(.hidden)");
  if(currentView){
    currentView.style.opacity = "0";
    currentView.style.transform = "translateY(8px)";
    setTimeout(() => {
      document.querySelectorAll(".view").forEach(v => {
        v.classList.add("hidden");
        v.style.opacity = "";
        v.style.transform = "";
      });
      const next = document.getElementById(`view-${name}`);
      next.classList.remove("hidden");
      next.style.animation = "none";
      void next.offsetWidth; // force reflow
      next.style.animation = "";
    }, 120);
  } else {
    document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
    document.getElementById(`view-${name}`).classList.remove("hidden");
  }

  document.querySelectorAll(".navBtn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  document.getElementById("mainNav").classList.remove("navOpen");

  // Small delay to allow transition
  setTimeout(() => {
    if(name === "dashboard") renderDashboard();
    if(name === "entry") renderEntry();
    if(name === "logs") renderLogs();
    if(name === "reports") renderReports();
    if(name === "admin") renderAdmin();
  }, name === "dashboard" && currentView ? 130 : 0);
}

document.getElementById("mobileNavToggle").addEventListener("click", () => {
  const nav = document.getElementById("mainNav");
  nav.classList.toggle("navOpen");
  document.getElementById("mobileNavToggle").setAttribute("aria-expanded", nav.classList.contains("navOpen"));
});

/* ---------------- Boot / Login ---------------- */
async function boot(){
  document.getElementById("topbar").classList.add("hidden");
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  document.getElementById("loginScreen").classList.remove("hidden");

  const session = AUTH.restoreSession();
  if(session) await afterLogin();
}

document.getElementById("loginBtn").addEventListener("click", async () => {
  const u = document.getElementById("loginUser").value.trim();
  const p = document.getElementById("loginPass").value;
  const errEl = document.getElementById("loginError");
  errEl.classList.add("hidden");
  const btn = document.getElementById("loginBtn");
  btn.disabled = true; btn.textContent = "Signing in…";
  try{
    await AUTH.login(u, p);
    await afterLogin();
  }catch(e){
    errEl.textContent = e.message || "Login failed.";
    errEl.classList.remove("hidden");
    // Shake animation on error
    const card = document.querySelector(".loginCard");
    card.style.animation = "shake 0.4s ease-in-out";
    setTimeout(() => card.style.animation = "", 400);
  }finally{
    btn.disabled = false; btn.textContent = "Sign in";
  }
});
document.getElementById("loginPass").addEventListener("keydown", e => {
  if(e.key === "Enter") document.getElementById("loginBtn").click();
});

// Add shake animation style dynamically
const shakeStyle = document.createElement("style");
shakeStyle.textContent = `@keyframes shake{0%,100%{transform:translateX(0);}20%{transform:translateX(-8px);}40%{transform:translateX(8px);}60%{transform:translateX(-4px);}80%{transform:translateX(4px);}}`;
document.head.appendChild(shakeStyle);

document.getElementById("logoutBtn").addEventListener("click", () => {
  AUTH.logout();
  clearInterval(pollTimer);
  DB.unsubscribeLive();
  document.getElementById("topbar").classList.add("hidden");
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  document.getElementById("loginUser").value = "";
  document.getElementById("loginPass").value = "";
  document.getElementById("loginScreen").classList.remove("hidden");
  toast("Signed out successfully", "success");
});

async function afterLogin(){
  document.getElementById("loginScreen").classList.add("hidden");
  setLoading(true, "Loading plant data…");
  try{
    await STORE.loadAll();
  }catch(e){
    toast("Failed to load data: " + e.message, "error");
    document.getElementById("loginScreen").classList.remove("hidden");
    setLoading(false);
    return;
  }
  setLoading(false);
  document.getElementById("topbar").classList.remove("hidden");
  document.getElementById("whoami").textContent = `${AUTH.session.name} · ${AUTH.session.role}`;
  document.querySelectorAll(".adminOnly").forEach(el => el.classList.toggle("hidden", !AUTH.isAdmin()));
  showView("dashboard");

  // Real-time updates: any device's Start/Stop or reading instantly
  // refreshes everyone else's dashboard, no polling needed for that.
  DB.subscribeLive(async () => {
    await STORE.refreshLive();
    if(!document.getElementById("view-dashboard").classList.contains("hidden")) renderDashboard();
    if(!document.getElementById("view-entry").classList.contains("hidden")) renderEntryDetail();
    if(!document.getElementById("view-logs").classList.contains("hidden")) renderLogsTable();
  }, updateLiveIndicator);

  // Slow fallback poll in case the realtime socket ever drops.
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    await STORE.refreshLive();
    if(!document.getElementById("view-dashboard").classList.contains("hidden")) renderDashboard();
    if(!document.getElementById("view-logs").classList.contains("hidden")) renderLogsTable();
  }, 45000);
}

document.querySelectorAll(".navBtn").forEach(btn => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});

/* ---------------- Dashboard ---------------- */
function visiblePlants(){
  if(AUTH.isAdmin()) return STORE.config.plants;
  return STORE.config.plants.filter(p => p.id === AUTH.session.plant);
}

function renderDashboard(){
  const bar = document.getElementById("plantFilterBar");
  const grid = document.getElementById("dashboardGrid");
  const plants = visiblePlants();

  if(!dashboardFilter || (dashboardFilter !== "ALL" && !plants.find(p => p.id === dashboardFilter))){
    dashboardFilter = "ALL";
  }
  bar.innerHTML = "";
  if(plants.length > 1){
    const allBtn = document.createElement("button");
    allBtn.textContent = "All Plants";
    allBtn.className = dashboardFilter === "ALL" ? "active" : "";
    allBtn.onclick = () => { dashboardFilter = "ALL"; renderDashboard(); };
    bar.appendChild(allBtn);
  }
  plants.forEach(p => {
    const b = document.createElement("button");
    b.textContent = p.name;
    b.className = dashboardFilter === p.id ? "active" : "";
    b.onclick = () => { dashboardFilter = p.id; renderDashboard(); };
    bar.appendChild(b);
  });

  const shown = dashboardFilter === "ALL" ? plants : plants.filter(p => p.id === dashboardFilter);
  const today = STORE.todayStr();
  const weekStart = STORE.weekStartStr();
  const monthStart = STORE.monthStartStr();
  grid.innerHTML = "";

  if(!shown.length){
    grid.innerHTML = `<div class="card emptyState"><p>No plants configured yet.</p><p class="hint">Ask an admin to add one under Admin → Plants.</p></div>`;
  }

  shown.forEach(plant => {
    const machines = STORE.machinesForPlant(plant.id);
    let plantKWh = 0, runningCount = 0;
    const rowsHtml = machines.map(m => {
      const { kw, baseKwh, openStart, kwh, measured } = STORE.liveEnergyState(plant.id, m.id, today, m.ratedKW);
      const running = !!openStart;
      if(running) runningCount++;
      plantKWh += kwh;
      const startAttr = running ? ` data-start="${openStart.toISOString()}" data-base-kwh="${baseKwh}" data-kw="${kw}"` : "";
      const sourceTag = `<span class="sourceTag ${measured ? "measured" : "rated"}" title="${measured ? "Uses a logged actual power reading for today" : "No reading logged today — estimated from this machine's rated kW"}">${measured ? "MEASURED" : "RATED"}</span>`;
      const todayHours = STORE.operatingHours(plant.id, m.id, today);
      const weekHours = STORE.rangeHours(plant.id, m.id, weekStart, today);
      const monthHours = STORE.rangeHours(plant.id, m.id, monthStart, today);
      return `<div class="machineRow">
        <div class="machineRowTop">
          <span class="machineName"><span class="lamp ${running ? "on" : ""}"></span>${m.name}</span>
          <span class="machineStat">${running ? "<strong style='color:var(--teal)'>RUNNING</strong>" : "STOPPED"} · <span class="kwh"${startAttr}>${kwh.toFixed(1)}</span> kWh${sourceTag}${running ? ` · <span class="elapsed" data-start="${openStart.toISOString()}">0:00:00</span>` : ""}</span>
        </div>
        <div class="hoursBreakdown">Today <b>${todayHours.toFixed(1)}h</b> · This week <b>${weekHours.toFixed(1)}h</b> · This month <b>${monthHours.toFixed(1)}h</b></div>
      </div>`;
    }).join("") || `<div class="emptyState" style="padding:20px"><p class="hint">No machines configured for this plant yet.</p></div>`;

    const card = document.createElement("div");
    card.className = "card plantCard";
    card.innerHTML = `
      <h3>${plant.name} <span class="meterChip">${plantKWh.toFixed(1)} kWh</span></h3>
      ${machines.length ? `<p class="runningCount">${runningCount} of ${machines.length} machine${machines.length === 1 ? "" : "s"} running now</p>` : ""}
      ${rowsHtml}
    `;
    grid.appendChild(card);
  });

  document.getElementById("dashUpdated").textContent = new Date().toLocaleTimeString();
}

/* ---------------- Data Entry ---------------- */
function fillPlantSelect(sel, plants){
  sel.innerHTML = plants.map(p => `<option value="${p.id}">${p.name}</option>`).join("");
}

function renderEntry(){
  const plants = visiblePlants();
  const plantSel = document.getElementById("entryPlantSelect");
  if(!plants.length){
    document.getElementById("runLogList").innerHTML = `<div class="emptyState"><p>No plant assigned yet.</p><p class="hint">Ask an admin to assign you to a plant.</p></div>`;
    return;
  }
  fillPlantSelect(plantSel, plants);
  currentEntryPlant = plants[0] ? plants[0].id : null;
  plantSel.value = currentEntryPlant;
  plantSel.onchange = () => { currentEntryPlant = plantSel.value; renderEntryDetail(); };
  renderEntryDetail();
}

function renderEntryDetail(){
  const machines = currentEntryPlant ? STORE.machinesForPlant(currentEntryPlant) : [];

  const today = STORE.todayStr();
  const logEl = document.getElementById("runLogList");
  logEl.innerHTML = machines.map(m => {
    const { openStart } = STORE.liveEnergyState(currentEntryPlant, m.id, today, m.ratedKW);
    const running = !!openStart;
    return `<div class="runLogRow">
      <div><span class="name">${m.name}</span><small>${m.category} · ${m.ratedKW} kW rated</small>
        ${running ? `<div class="elapsed" data-start="${openStart.toISOString()}" data-label="Running: ">Running: 0:00:00</div>` : ""}
      </div>
      <div class="btnRow">
        <button class="btnStart" data-m="${m.id}" ${running ? "disabled" : ""}>Start</button>
        <button class="btnStop" data-m="${m.id}" ${running ? "" : "disabled"}>Stop</button>
      </div>
    </div>`;
  }).join("") || `<div class="emptyState"><p class="hint">No machines configured for this plant.</p></div>`;

  logEl.querySelectorAll(".btnStart").forEach(b => b.onclick = () => logEvent(b.dataset.m, "start"));
  logEl.querySelectorAll(".btnStop").forEach(b => b.onclick = () => logEvent(b.dataset.m, "stop"));

  const opts = machines.map(m => `<option value="${m.id}">${m.name}</option>`).join("");
  document.getElementById("shiftMachine").innerHTML = opts;
  document.getElementById("readingMachine").innerHTML = opts;
  document.getElementById("shiftDate").value = STORE.todayStr();
  document.getElementById("readingDate").value = STORE.todayStr();
}

async function logEvent(machineId, type){
  try{
    const record = {
      id: STORE.uid("ev"), plant_id: currentEntryPlant, machine_id: machineId, type,
      ts: new Date().toISOString(), by_username: AUTH.session.username
    };
    await DB.insert("events", record);
    await STORE.refreshLive();
    renderEntryDetail();
    toast(`${type === "start" ? "Started" : "Stopped"} machine successfully`, "success");
  }catch(e){ toast("Failed to save: " + e.message, "error"); }
}

document.getElementById("shiftForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const date = document.getElementById("shiftDate").value;
  const hours = Number(document.getElementById("shiftHours").value);
  const machineId = document.getElementById("shiftMachine").value;
  if(!date || !(hours > 0)){ toast("Please fill in date and a positive number of hours.", "error"); return; }
  // Sanity check: a machine physically can't run more than 24h in one day.
  // Warn (rather than silently accept) if this entry would push the day's
  // logged shift total for this machine past that.
  const alreadyLogged = STORE.hoursFromShifts(currentEntryPlant, machineId, date);
  if(alreadyLogged + hours > 24){
    toast(`That's ${(alreadyLogged + hours).toFixed(1)} hours logged for this machine on ${date} — more than a full day. Check the date/hours before saving.`, "error");
    return;
  }
  const record = {
    id: STORE.uid("sh"), plant_id: currentEntryPlant,
    machine_id: machineId,
    date, shift_name: document.getElementById("shiftName").value,
    hours, by_username: AUTH.session.username
  };
  try{
    await DB.insert("shifts", record);
    STORE.shifts.push(STORE._mapShift(record));
    document.getElementById("shiftHours").value = "";
    showEntryMsg("Shift hours saved successfully.");
    if(!document.getElementById("view-dashboard").classList.contains("hidden")) renderDashboard();
  }catch(e){ toast("Failed to save: " + e.message, "error"); }
});

document.getElementById("readingForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const date = document.getElementById("readingDate").value;
  const kw = Number(document.getElementById("readingKW").value);
  const machineId = document.getElementById("readingMachine").value;
  if(!date || !(kw >= 0)){ toast("Please fill in date and power reading.", "error"); return; }
  // Sanity check: catch likely typos (e.g. extra digit) by comparing
  // against the machine's rated kW, without blocking a genuine reading.
  const machine = STORE.machineById(machineId);
  if(machine && machine.ratedKW > 0 && kw > machine.ratedKW * 3){
    const ok = await confirmDialog(
      "Unusually high reading",
      `${kw} kW is more than 3× ${machine.name}'s rated ${machine.ratedKW} kW. Save it anyway?`,
      "Save anyway"
    );
    if(!ok) return;
  }
  const record = {
    id: STORE.uid("rd"), plant_id: currentEntryPlant,
    machine_id: machineId,
    date, ts: new Date().toISOString(), kw, by_username: AUTH.session.username
  };
  try{
    await DB.insert("readings", record);
    STORE.readings.push({ id: record.id, plant: record.plant_id, machine: record.machine_id, date: record.date, timestamp: record.ts, kW: record.kw, by: record.by_username });
    document.getElementById("readingKW").value = "";
    showEntryMsg("Power reading saved successfully.");
    if(!document.getElementById("view-dashboard").classList.contains("hidden")) renderDashboard();
  }catch(e){ toast("Failed to save: " + e.message, "error"); }
});

function showEntryMsg(text){
  const el = document.getElementById("entryMsg");
  el.textContent = text;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 3000);
}

/* ---------------- Logs ----------------
 * History + corrections for run events, shift hours, and power readings.
 * Edits/deletes are gated client-side (admin, or the technician who
 * originally logged the row) — same open-anon-key trust model as the rest
 * of the app; every edit is stamped with edited_at/edited_by so there's a
 * visible trail. */
let logsFilter = { plant: null, machine: "ALL", from: null, to: null };
let logsTab = "events";
let logsEditing = null; // { type: "events" | "shifts" | "readings", id }

function canEditLogRow(row){
  return AUTH.isAdmin() || (AUTH.session && row.by === AUTH.session.username);
}
function editedTag(row){
  return row.editedAt ? `<div class="editedBadge">Edited by ${row.editedBy || "?"}</div>` : "";
}
function logsInRange(dateStr){
  return dateStr >= logsFilter.from && dateStr <= logsFilter.to;
}
// Plants a given log row should match against the current filter.
function logsMatchesPlant(rowPlantId){
  return logsFilter.plant === "ALL" || rowPlantId === logsFilter.plant;
}

function renderLogs(){
  const plants = visiblePlants();
  if(!plants.length){
    document.getElementById("logsTableWrap").innerHTML = `<div class="emptyState"><p>No plant assigned yet.</p><p class="hint">Ask an admin to assign you to a plant.</p></div>`;
    return;
  }

  // Plant filter: pill buttons (matches the Dashboard's "All Plants" pattern)
  // instead of a <select>, so admins can see every plant's logs at once.
  const bar = document.getElementById("logsPlantBar");
  if(!logsFilter.plant || (logsFilter.plant !== "ALL" && !plants.find(p => p.id === logsFilter.plant))){
    logsFilter.plant = plants.length > 1 ? "ALL" : plants[0].id;
  }
  bar.innerHTML = "";
  if(plants.length > 1){
    const allBtn = document.createElement("button");
    allBtn.textContent = "All Plants";
    allBtn.className = logsFilter.plant === "ALL" ? "active" : "";
    allBtn.onclick = () => { logsFilter.plant = "ALL"; logsFilter.machine = "ALL"; logsEditing = null; renderLogsDetail(); };
    bar.appendChild(allBtn);
  }
  plants.forEach(p => {
    const b = document.createElement("button");
    b.textContent = p.name;
    b.className = logsFilter.plant === p.id ? "active" : "";
    b.onclick = () => { logsFilter.plant = p.id; logsFilter.machine = "ALL"; logsEditing = null; renderLogsDetail(); };
    bar.appendChild(b);
  });

  if(!logsFilter.from || !logsFilter.to){
    const from = new Date();
    from.setDate(from.getDate() - 6);
    logsFilter.from = from.toISOString().slice(0, 10);
    logsFilter.to = STORE.todayStr();
  }
  const fromEl = document.getElementById("logsFrom");
  const toEl = document.getElementById("logsTo");
  fromEl.value = logsFilter.from;
  toEl.value = logsFilter.to;
  fromEl.onchange = () => { if(fromEl.value){ logsFilter.from = fromEl.value; logsEditing = null; renderLogsTable(); } };
  toEl.onchange = () => { if(toEl.value){ logsFilter.to = toEl.value; logsEditing = null; renderLogsTable(); } };

  document.querySelectorAll("[data-logtab]").forEach(b => {
    b.onclick = () => { logsTab = b.dataset.logtab; logsEditing = null; renderLogsDetail(); };
  });

  renderLogsDetail();
}

function renderLogsDetail(){
  // Machine filter stays a dropdown; when viewing all plants it lists
  // every machine across those plants (grouped by plant name).
  const machineSel = document.getElementById("logsMachineSelect");
  const plants = logsFilter.plant === "ALL" ? visiblePlants() : [STORE.plantById(logsFilter.plant)].filter(Boolean);
  let allMachines = [];
  let options = `<option value="ALL">All Machines</option>`;
  if(logsFilter.plant === "ALL"){
    options += plants.map(p => {
      const machines = STORE.machinesForPlant(p.id);
      allMachines = allMachines.concat(machines);
      if(!machines.length) return "";
      return `<optgroup label="${p.name}">${machines.map(m => `<option value="${m.id}">${m.name}</option>`).join("")}</optgroup>`;
    }).join("");
  } else {
    allMachines = STORE.machinesForPlant(logsFilter.plant);
    options += allMachines.map(m => `<option value="${m.id}">${m.name}</option>`).join("");
  }
  machineSel.innerHTML = options;
  if(!allMachines.find(m => m.id === logsFilter.machine)) logsFilter.machine = "ALL";
  machineSel.value = logsFilter.machine;
  machineSel.onchange = () => { logsFilter.machine = machineSel.value; logsEditing = null; renderLogsTable(); };

  document.querySelectorAll("[data-logtab]").forEach(b => b.classList.toggle("active", b.dataset.logtab === logsTab));
  renderLogsTable();
}

function renderLogsTable(){
  const wrap = document.getElementById("logsTableWrap");
  const matchesMachine = id => logsFilter.machine === "ALL" || id === logsFilter.machine;

  const showPlantCol = logsFilter.plant === "ALL";
  const plantCell = r => showPlantCol ? `<td>${(STORE.plantById(r.plant) || {}).name || r.plant}</td>` : "";
  const plantHeader = showPlantCol ? "<th>Plant</th>" : "";

  if(logsTab === "events"){
    const rows = STORE.events
      .filter(e => logsMatchesPlant(e.plant) && matchesMachine(e.machine) && logsInRange(e.timestamp.slice(0, 10)))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    wrap.innerHTML = rows.length ? `<table><tr>${plantHeader}<th>Date / Time</th><th>Machine</th><th>Type</th><th>By</th><th>Actions</th></tr>` +
      rows.map(r => {
        const machine = STORE.machineById(r.machine);
        if(logsEditing && logsEditing.type === "events" && logsEditing.id === r.id){
          const dt = new Date(r.timestamp);
          const localVal = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
          return `<tr>
            ${plantCell(r)}
            <td><input type="datetime-local" class="tdInput" id="editEventTs" value="${localVal}"></td>
            <td>${machine ? machine.name : r.machine}</td>
            <td>${r.type === "start" ? "Start" : "Stop"}</td>
            <td>${r.by || "-"}</td>
            <td class="tableActions">
              <button class="btnSmall" data-save-event="${r.id}">Save</button>
              <button class="btnSmall" data-cancel-log>Cancel</button>
            </td>
          </tr>`;
        }
        return `<tr>
          ${plantCell(r)}
          <td>${new Date(r.timestamp).toLocaleString()}${editedTag(r)}</td>
          <td>${machine ? machine.name : r.machine}</td>
          <td>${r.type === "start" ? "Start" : "Stop"}</td>
          <td>${r.by || "-"}</td>
          <td class="tableActions">${canEditLogRow(r) ? `<button class="btnSmall" data-edit-event="${r.id}">Edit</button><button class="btnIconDanger" data-del-event="${r.id}">Delete</button>` : ""}</td>
        </tr>`;
      }).join("") + "</table>" : `<div class="emptyState"><p class="hint">No run events in this range.</p></div>`;

    wrap.querySelectorAll("[data-edit-event]").forEach(b => b.onclick = () => { logsEditing = { type: "events", id: b.dataset.editEvent }; renderLogsTable(); });
    wrap.querySelectorAll("[data-cancel-log]").forEach(b => b.onclick = () => { logsEditing = null; renderLogsTable(); });
    wrap.querySelectorAll("[data-save-event]").forEach(b => b.onclick = async () => {
      const id = b.dataset.saveEvent;
      const val = document.getElementById("editEventTs").value;
      if(!val){ toast("Choose a valid date/time.", "error"); return; }
      try{
        await STORE.updateEvent(id, { timestamp: new Date(val).toISOString() }, AUTH.session.username);
        logsEditing = null;
        renderLogsTable();
        if(!document.getElementById("view-dashboard").classList.contains("hidden")) renderDashboard();
        toast("Event updated.", "success");
      }catch(e){ toast("Failed to update: " + e.message, "error"); }
    });
    wrap.querySelectorAll("[data-del-event]").forEach(b => b.onclick = async () => {
      const id = b.dataset.delEvent;
      const ok = await confirmDialog("Delete this event?", "This permanently removes this Start/Stop entry from the run log.");
      if(!ok) return;
      try{
        await STORE.deleteEvent(id);
        renderLogsTable();
        if(!document.getElementById("view-dashboard").classList.contains("hidden")) renderDashboard();
        toast("Event deleted.", "success");
      }catch(e){ toast("Failed to delete: " + e.message, "error"); }
    });
    return;
  }

  if(logsTab === "shifts"){
    const rows = STORE.shifts
      .filter(s => logsMatchesPlant(s.plant) && matchesMachine(s.machine) && logsInRange(s.date))
      .sort((a, b) => b.date.localeCompare(a.date));
    wrap.innerHTML = rows.length ? `<table><tr>${plantHeader}<th>Date</th><th>Machine</th><th>Shift</th><th>Hours</th><th>By</th><th>Actions</th></tr>` +
      rows.map(r => {
        const machine = STORE.machineById(r.machine);
        if(logsEditing && logsEditing.type === "shifts" && logsEditing.id === r.id){
          return `<tr>
            ${plantCell(r)}
            <td><input type="date" class="tdInput" id="editShiftDate" value="${r.date}"></td>
            <td>${machine ? machine.name : r.machine}</td>
            <td><select class="tdInput" id="editShiftName">${["Shift 1", "Shift 2", "Shift 3"].map(s => `<option ${s === r.shift ? "selected" : ""}>${s}</option>`).join("")}</select></td>
            <td><input type="number" step="0.1" min="0" max="24" class="tdInput" id="editShiftHours" value="${r.hours}"></td>
            <td>${r.by || "-"}</td>
            <td class="tableActions">
              <button class="btnSmall" data-save-shift="${r.id}">Save</button>
              <button class="btnSmall" data-cancel-log>Cancel</button>
            </td>
          </tr>`;
        }
        return `<tr>
          ${plantCell(r)}
          <td>${r.date}${editedTag(r)}</td>
          <td>${machine ? machine.name : r.machine}</td>
          <td>${r.shift || "-"}</td>
          <td>${r.hours.toFixed(1)}</td>
          <td>${r.by || "-"}</td>
          <td class="tableActions">${canEditLogRow(r) ? `<button class="btnSmall" data-edit-shift="${r.id}">Edit</button><button class="btnIconDanger" data-del-shift="${r.id}">Delete</button>` : ""}</td>
        </tr>`;
      }).join("") + "</table>" : `<div class="emptyState"><p class="hint">No shift entries in this range.</p></div>`;

    wrap.querySelectorAll("[data-edit-shift]").forEach(b => b.onclick = () => { logsEditing = { type: "shifts", id: b.dataset.editShift }; renderLogsTable(); });
    wrap.querySelectorAll("[data-cancel-log]").forEach(b => b.onclick = () => { logsEditing = null; renderLogsTable(); });
    wrap.querySelectorAll("[data-save-shift]").forEach(b => b.onclick = async () => {
      const id = b.dataset.saveShift;
      const date = document.getElementById("editShiftDate").value;
      const shift = document.getElementById("editShiftName").value;
      const hours = Number(document.getElementById("editShiftHours").value);
      if(!date || !(hours > 0) || hours > 24){ toast("Enter a valid date and hours between 0 and 24.", "error"); return; }
      try{
        await STORE.updateShift(id, { date, shift, hours }, AUTH.session.username);
        logsEditing = null;
        renderLogsTable();
        if(!document.getElementById("view-dashboard").classList.contains("hidden")) renderDashboard();
        toast("Shift entry updated.", "success");
      }catch(e){ toast("Failed to update: " + e.message, "error"); }
    });
    wrap.querySelectorAll("[data-del-shift]").forEach(b => b.onclick = async () => {
      const id = b.dataset.delShift;
      const ok = await confirmDialog("Delete this shift entry?", "This permanently removes this shift-hours entry.");
      if(!ok) return;
      try{
        await STORE.deleteShift(id);
        renderLogsTable();
        if(!document.getElementById("view-dashboard").classList.contains("hidden")) renderDashboard();
        toast("Shift entry deleted.", "success");
      }catch(e){ toast("Failed to delete: " + e.message, "error"); }
    });
    return;
  }

  if(logsTab === "readings"){
    const rows = STORE.readings
      .filter(r => logsMatchesPlant(r.plant) && matchesMachine(r.machine) && logsInRange(r.date))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    wrap.innerHTML = rows.length ? `<table><tr>${plantHeader}<th>Date</th><th>Machine</th><th>Time</th><th>kW</th><th>By</th><th>Actions</th></tr>` +
      rows.map(r => {
        const machine = STORE.machineById(r.machine);
        if(logsEditing && logsEditing.type === "readings" && logsEditing.id === r.id){
          const dt = new Date(r.timestamp);
          const localVal = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
          return `<tr>
            ${plantCell(r)}
            <td><input type="date" class="tdInput" id="editReadingDate" value="${r.date}"></td>
            <td>${machine ? machine.name : r.machine}</td>
            <td><input type="datetime-local" class="tdInput" id="editReadingTs" value="${localVal}"></td>
            <td><input type="number" step="0.01" min="0" class="tdInput" id="editReadingKW" value="${r.kW}"></td>
            <td>${r.by || "-"}</td>
            <td class="tableActions">
              <button class="btnSmall" data-save-reading="${r.id}">Save</button>
              <button class="btnSmall" data-cancel-log>Cancel</button>
            </td>
          </tr>`;
        }
        return `<tr>
          ${plantCell(r)}
          <td>${r.date}${editedTag(r)}</td>
          <td>${machine ? machine.name : r.machine}</td>
          <td>${new Date(r.timestamp).toLocaleTimeString()}</td>
          <td>${r.kW}</td>
          <td>${r.by || "-"}</td>
          <td class="tableActions">${canEditLogRow(r) ? `<button class="btnSmall" data-edit-reading="${r.id}">Edit</button><button class="btnIconDanger" data-del-reading="${r.id}">Delete</button>` : ""}</td>
        </tr>`;
      }).join("") + "</table>" : `<div class="emptyState"><p class="hint">No power readings in this range.</p></div>`;

    wrap.querySelectorAll("[data-edit-reading]").forEach(b => b.onclick = () => { logsEditing = { type: "readings", id: b.dataset.editReading }; renderLogsTable(); });
    wrap.querySelectorAll("[data-cancel-log]").forEach(b => b.onclick = () => { logsEditing = null; renderLogsTable(); });
    wrap.querySelectorAll("[data-save-reading]").forEach(b => b.onclick = async () => {
      const id = b.dataset.saveReading;
      const date = document.getElementById("editReadingDate").value;
      const tsVal = document.getElementById("editReadingTs").value;
      const kW = Number(document.getElementById("editReadingKW").value);
      if(!date || !tsVal || !(kW >= 0)){ toast("Enter a valid date, time, and kW.", "error"); return; }
      try{
        await STORE.updateReading(id, { date, timestamp: new Date(tsVal).toISOString(), kW }, AUTH.session.username);
        logsEditing = null;
        renderLogsTable();
        if(!document.getElementById("view-dashboard").classList.contains("hidden")) renderDashboard();
        toast("Reading updated.", "success");
      }catch(e){ toast("Failed to update: " + e.message, "error"); }
    });
    wrap.querySelectorAll("[data-del-reading]").forEach(b => b.onclick = async () => {
      const id = b.dataset.delReading;
      const ok = await confirmDialog("Delete this reading?", "This permanently removes this power reading.");
      if(!ok) return;
      try{
        await STORE.deleteReading(id);
        renderLogsTable();
        if(!document.getElementById("view-dashboard").classList.contains("hidden")) renderDashboard();
        toast("Reading deleted.", "success");
      }catch(e){ toast("Failed to delete: " + e.message, "error"); }
    });
    return;
  }
}

/* ---------------- Reports ---------------- */
function renderReports(){
  const sel = document.getElementById("reportPlantSelect");
  const plants = visiblePlants();
  sel.innerHTML = `<option value="ALL">All Plants</option>` + plants.map(p => `<option value="${p.id}">${p.name}</option>`).join("");
  const today = STORE.todayStr();
  document.getElementById("reportFrom").value = today;
  document.getElementById("reportTo").value = today;
}

document.getElementById("generateReportBtn").addEventListener("click", () => {
  const plant = document.getElementById("reportPlantSelect").value;
  const from = document.getElementById("reportFrom").value;
  const to = document.getElementById("reportTo").value;
  const msg = document.getElementById("reportMsg");
  if(!from || !to || from > to){ msg.textContent = "Please choose a valid date range."; return; }
  const btn = document.getElementById("generateReportBtn");
  btn.disabled = true;
  btn.textContent = "Generating…";
  try{
    const fname = REPORTS.generate(plant, from, to);
    msg.textContent = `Downloaded ${fname}`;
    msg.style.color = "var(--teal)";
  }catch(e){ 
    msg.textContent = "Failed to generate report: " + e.message; 
    msg.style.color = "var(--alert)";
  } finally {
    btn.disabled = false;
    btn.textContent = "Generate PDF Report";
  }
});

/* ---------------- Admin: Plants ---------------- */
function renderAdminPlants(){
  const plantsEl = document.getElementById("adminPlantsList");
  if(!STORE.config.plants.length){
    plantsEl.innerHTML = `<div class="emptyState" style="padding:20px"><p class="hint">No plants yet — add one below.</p></div>`;
    return;
  }
  plantsEl.innerHTML = STORE.config.plants.map(p => {
    const machineCount = STORE.machinesForPlant(p.id).length;
    return `<div class="mgmtRow">
      <div><strong>${p.name}</strong><small>${machineCount} machine${machineCount === 1 ? "" : "s"}</small></div>
      <button class="btnIconDanger" data-plant="${p.id}" data-name="${p.name}" title="Delete plant">Delete</button>
    </div>`;
  }).join("");
  plantsEl.querySelectorAll("[data-plant]").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.plant, name = btn.dataset.name;
      const ok = await confirmDialog(
        `Delete ${name}?`,
        `This permanently deletes ${name}, all of its machines, and every logged event/shift/reading for it. This cannot be undone.`
      );
      if(!ok) return;
      try{
        await DB.remove("plants", { id });
        STORE.config.plants = STORE.config.plants.filter(p => p.id !== id);
        STORE.config.machines = STORE.config.machines.filter(m => m.plantId !== id);
        renderAdmin();
        toast(`${name} deleted.`, "success");
      }catch(e){ toast("Failed to delete: " + e.message, "error"); }
    };
  });
}

document.getElementById("addPlantForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById("newPlantName");
  const name = nameInput.value.trim();
  if(!name){ toast("Enter a plant name.", "error"); return; }
  if(STORE.config.plants.some(p => p.name.toLowerCase() === name.toLowerCase())){
    toast("A plant with that name already exists.", "error"); return;
  }
  const id = STORE.uid(STORE.slugify(name));
  try{
    await DB.insert("plants", { id, name });
    STORE.config.plants.push({ id, name });
    nameInput.value = "";
    renderAdmin();
    toast(`${name} added.`, "success");
  }catch(e){ toast("Failed to save: " + e.message, "error"); }
});

/* ---------------- Admin: Machines ---------------- */
function renderAdminMachines(){
  const el = document.getElementById("adminMachinesList");
  const newMachinePlant = document.getElementById("newMachinePlant");
  newMachinePlant.innerHTML = STORE.config.plants.map(p => `<option value="${p.id}">${p.name}</option>`).join("");

  if(!STORE.config.plants.length){
    el.innerHTML = `<div class="emptyState" style="padding:20px"><p class="hint">Add a plant first.</p></div>`;
    document.getElementById("addMachineBtn").disabled = true;
    return;
  }
  document.getElementById("addMachineBtn").disabled = false;

  el.innerHTML = STORE.config.plants.map(p => {
    const machines = STORE.machinesForPlant(p.id);
    const rows = machines.map(m => `<div class="mgmtRow">
        <div><strong>${m.name}</strong><small>${m.category} · ${m.ratedKW} kW rated</small></div>
        <button class="btnIconDanger" data-machine="${m.id}" data-name="${m.name}" title="Delete machine">Delete</button>
      </div>`).join("") || `<div class="emptyState" style="padding:12px 0"><p class="hint">No machines yet.</p></div>`;
    return `<h4>${p.name} (${machines.length}/10)</h4>${rows}`;
  }).join("");

  el.querySelectorAll("[data-machine]").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.machine, name = btn.dataset.name;
      const ok = await confirmDialog(`Delete ${name}?`, `This permanently deletes ${name} and all of its logged event/shift/reading history. This cannot be undone.`);
      if(!ok) return;
      try{
        await DB.remove("machines", { id });
        STORE.config.machines = STORE.config.machines.filter(m => m.id !== id);
        renderAdmin();
        toast(`${name} deleted.`, "success");
      }catch(e){ toast("Failed to delete: " + e.message, "error"); }
    };
  });
}

document.getElementById("addMachineForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const plantId = document.getElementById("newMachinePlant").value;
  if(!plantId){ toast("Add a plant first.", "error"); return; }
  const existing = STORE.machinesForPlant(plantId);
  if(existing.length >= 10){ toast("This plant already has 10 machines (maximum).", "error"); return; }
  const name = document.getElementById("newMachineName").value.trim();
  const ratedKW = Number(document.getElementById("newMachineKW").value);
  if(existing.some(m => m.name.toLowerCase() === name.toLowerCase())){
    toast("This plant already has a machine with that name.", "error"); return;
  }
  if(!(ratedKW > 0)){ toast("Rated power (kW) must be greater than 0.", "error"); return; }
  const machine = {
    id: STORE.uid("m"), plantId,
    name,
    category: document.getElementById("newMachineCategory").value.trim(),
    ratedKW
  };
  try{
    await DB.insert("machines", { id: machine.id, plant_id: machine.plantId, name: machine.name, category: machine.category, rated_kw: machine.ratedKW });
    STORE.config.machines.push(machine);
    document.getElementById("addMachineForm").reset();
    renderAdmin();
    toast("Machine added.", "success");
  }catch(err){ toast("Failed to save: " + err.message, "error"); }
});

/* ---------------- Admin: Users ---------------- */
function renderAdminUsers(){
  const usersEl = document.getElementById("adminUsersList");
  const newUserPlant = document.getElementById("newUserPlant");
  const newUserRole = document.getElementById("newUserRole");
  newUserPlant.innerHTML = STORE.config.plants.map(p => `<option value="${p.id}">${p.name}</option>`).join("");
  const syncPlantFieldState = () => { newUserPlant.disabled = newUserRole.value === "admin"; };
  newUserRole.onchange = syncPlantFieldState;
  syncPlantFieldState();

  usersEl.innerHTML = "<table><tr><th>Name</th><th>Username</th><th>Role</th><th>Plant</th><th>Status</th><th>Actions</th></tr>" +
    STORE.users.map(u => {
      const isSelf = AUTH.session && u.username === AUTH.session.username;
      const plantName = u.plant ? ((STORE.plantById(u.plant) || {}).name || u.plant) : "-";
      return `<tr>
        <td>${u.name}</td><td>${u.username}</td><td>${u.role}</td><td>${plantName}</td>
        <td>${u.active ? "Active" : "<span class='muted'>Disabled</span>"}</td>
        <td class="tableActions">
          <button class="btnSmall" data-toggle="${u.username}" data-active="${u.active}" ${isSelf ? "disabled title='Cannot disable your own account'" : ""}>${u.active ? "Disable" : "Enable"}</button>
          <button class="btnIconDanger" data-deluser="${u.username}" data-name="${u.name}" ${isSelf ? "disabled title='Cannot delete your own account'" : ""}>Delete</button>
        </td>
      </tr>`;
    }).join("") +
    "</table>";

  usersEl.querySelectorAll("[data-toggle]").forEach(btn => {
    btn.onclick = async () => {
      const username = btn.dataset.toggle;
      const nextActive = btn.dataset.active !== "true";
      try{
        await DB.rpc("admin_set_user_active", { p_username: username, p_active: nextActive });
        await STORE.reloadUsers();
        renderAdmin();
        toast(nextActive ? "User enabled." : "User disabled.", "success");
      }catch(e){ toast("Failed to update: " + e.message, "error"); }
    };
  });

  usersEl.querySelectorAll("[data-deluser]").forEach(btn => {
    btn.onclick = async () => {
      const username = btn.dataset.deluser, name = btn.dataset.name;
      const ok = await confirmDialog(`Delete ${name}?`, `This permanently removes the login for ${name} (${username}).`);
      if(!ok) return;
      try{
        await DB.rpc("admin_delete_user", { p_username: username });
        await STORE.reloadUsers();
        renderAdmin();
        toast(`${name} deleted.`, "success");
      }catch(e){ toast("Failed to delete: " + e.message, "error"); }
    };
  });
}

document.getElementById("addUserForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const role = document.getElementById("newUserRole").value;
  const name = document.getElementById("newUserName").value.trim();
  const username = document.getElementById("newUserUsername").value.trim();
  const password = document.getElementById("newUserPassword").value;
  const plantId = role === "technician" ? document.getElementById("newUserPlant").value : null;
  if(STORE.users.find(u => u.username.toLowerCase() === username.toLowerCase())){
    toast("Username already exists.", "error"); return;
  }
  if(password.length < 6){
    toast("Password must be at least 6 characters.", "error"); return;
  }
  if(role === "technician" && !plantId){
    toast("Choose a plant for this technician.", "error"); return;
  }
  try{
    await DB.rpc("admin_add_user", { p_name: name, p_username: username, p_role: role, p_plant_id: plantId, p_password: password });
    await STORE.reloadUsers();
    document.getElementById("addUserForm").reset();
    renderAdmin();
    toast("User added.", "success");
  }catch(err){ toast("Failed to save: " + err.message, "error"); }
});

/* ---------------- Admin: entry point ---------------- */
function renderAdmin(){
  if(!AUTH.isAdmin()){ showView("dashboard"); return; }
  renderAdminPlants();
  renderAdminMachines();
  renderAdminUsers();
}

boot();