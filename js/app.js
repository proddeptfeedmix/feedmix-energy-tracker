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
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.add("hidden"), 3000);
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
  });
}

function showView(name){
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  document.getElementById(`view-${name}`).classList.remove("hidden");
  document.querySelectorAll(".navBtn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  document.getElementById("mainNav").classList.remove("navOpen");
  if(name === "dashboard") renderDashboard();
  if(name === "entry") renderEntry();
  if(name === "reports") renderReports();
  if(name === "admin") renderAdmin();
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
  }finally{
    btn.disabled = false; btn.textContent = "Sign in";
  }
});
document.getElementById("loginPass").addEventListener("keydown", e => {
  if(e.key === "Enter") document.getElementById("loginBtn").click();
});

document.getElementById("logoutBtn").addEventListener("click", () => {
  AUTH.logout();
  clearInterval(pollTimer);
  DB.unsubscribeLive();
  document.getElementById("topbar").classList.add("hidden");
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  document.getElementById("loginUser").value = "";
  document.getElementById("loginPass").value = "";
  document.getElementById("loginScreen").classList.remove("hidden");
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
  }, updateLiveIndicator);

  // Slow fallback poll in case the realtime socket ever drops.
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    await STORE.refreshLive();
    if(!document.getElementById("view-dashboard").classList.contains("hidden")) renderDashboard();
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
  grid.innerHTML = "";

  if(!shown.length){
    grid.innerHTML = "<p class='hint'>No plants configured yet. Ask an admin to add one under Admin → Plants.</p>";
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
      return `<div class="machineRow">
        <span class="machineName"><span class="lamp ${running ? "on" : ""}"></span>${m.name}</span>
        <span class="machineStat">${running ? "RUNNING" : "STOPPED"} · <span class="kwh"${startAttr}>${kwh.toFixed(1)}</span> kWh${sourceTag}${running ? ` · <span class="elapsed" data-start="${openStart.toISOString()}">0:00:00</span>` : ""}</span>
      </div>`;
    }).join("") || "<p class='hint'>No machines configured for this plant yet.</p>";

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
    document.getElementById("runLogList").innerHTML = "<p class='hint'>No plant assigned yet — ask an admin.</p>";
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
  }).join("") || "<p class='hint'>No machines configured for this plant.</p>";

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
    toast(`${type === "start" ? "Started" : "Stopped"} machine.`, "success");
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
    showEntryMsg("Shift hours saved.");
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
    showEntryMsg("Power reading saved.");
    if(!document.getElementById("view-dashboard").classList.contains("hidden")) renderDashboard();
  }catch(e){ toast("Failed to save: " + e.message, "error"); }
});

function showEntryMsg(text){
  const el = document.getElementById("entryMsg");
  el.textContent = text;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 2500);
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
  try{
    const fname = REPORTS.generate(plant, from, to);
    msg.textContent = `Downloaded ${fname}`;
  }catch(e){ msg.textContent = "Failed to generate report: " + e.message; }
});

/* ---------------- Admin: Plants ---------------- */
function renderAdminPlants(){
  const plantsEl = document.getElementById("adminPlantsList");
  if(!STORE.config.plants.length){
    plantsEl.innerHTML = "<p class='hint'>No plants yet — add one below.</p>";
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
    el.innerHTML = "<p class='hint'>Add a plant first.</p>";
    document.getElementById("addMachineBtn").disabled = true;
    return;
  }

  el.innerHTML = STORE.config.plants.map(p => {
    const machines = STORE.machinesForPlant(p.id);
    const rows = machines.map(m => `<div class="mgmtRow">
        <div><strong>${m.name}</strong><small>${m.category} · ${m.ratedKW} kW rated</small></div>
        <button class="btnIconDanger" data-machine="${m.id}" data-name="${m.name}" title="Delete machine">Delete</button>
      </div>`).join("") || "<p class='hint'>No machines yet.</p>";
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
