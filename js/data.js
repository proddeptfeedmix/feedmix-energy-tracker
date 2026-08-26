/* data.js - loads/caches plants, machines, users, events, shifts, readings
 * from Supabase and provides the energy-calculation logic shared by the
 * dashboard, entry forms, and PDF reports. Field names here stay
 * camelCase (plantId, ratedKW, ...) — the mapping from Postgres's
 * snake_case columns happens once, in loadAll()/refreshLive().
 */
const STORE = {
  config: { plants: [], machines: [] }, // machines: [{id, plantId, name, category, ratedKW}]
  users: [],    // [{id, name, username, role, plant, active}] (no password hash — ever)
  events: [],   // {id, plant, machine, type: start|stop, timestamp, by}
  shifts: [],   // {id, plant, machine, date, shift, hours, by}
  readings: [], // {id, plant, machine, date, timestamp, kW, by}

  async loadAll(){
    const [plants, machines, users, events, shifts, readings] = await Promise.all([
      DB.select("plants", { order: { column: "name" } }),
      DB.select("machines"),
      DB.select("user_directory", { order: { column: "name" } }),
      DB.select("events"),
      DB.select("shifts"),
      DB.select("readings"),
    ]);
    this.config.plants = plants.map(p => ({ id: p.id, name: p.name }));
    this.config.machines = machines.map(m => ({ id: m.id, plantId: m.plant_id, name: m.name, category: m.category, ratedKW: Number(m.rated_kw) }));
    this.users = users.map(u => ({ id: u.id, name: u.name, username: u.username, role: u.role, plant: u.plant_id, active: u.active }));
    this._mapLive(events, readings);
    this.shifts = shifts.map(this._mapShift);
  },

  async refreshLive(){
    // Lighter refresh used by dashboard polling / realtime callbacks.
    const [events, readings] = await Promise.all([
      DB.select("events"),
      DB.select("readings"),
    ]);
    this._mapLive(events, readings);
  },

  _mapLive(events, readings){
    this.events = events.map(e => ({ id: e.id, plant: e.plant_id, machine: e.machine_id, type: e.type, timestamp: e.ts, by: e.by_username }));
    this.readings = readings.map(r => ({ id: r.id, plant: r.plant_id, machine: r.machine_id, date: r.date, timestamp: r.ts, kW: Number(r.kw), by: r.by_username }));
  },

  _mapShift(s){
    return { id: s.id, plant: s.plant_id, machine: s.machine_id, date: s.date, shift: s.shift_name, hours: Number(s.hours), by: s.by_username };
  },

  async reloadUsers(){
    const rows = await DB.select("user_directory", { order: { column: "name" } });
    this.users = rows.map(u => ({ id: u.id, name: u.name, username: u.username, role: u.role, plant: u.plant_id, active: u.active }));
  },

  machinesForPlant(plantId){
    return this.config.machines.filter(m => m.plantId === plantId);
  },
  machineById(id){
    return this.config.machines.find(m => m.id === id);
  },
  plantById(id){
    return this.config.plants.find(p => p.id === id);
  },

  todayStr(){
    return new Date().toISOString().slice(0, 10);
  },

  /* Is a machine currently running (open start event with no later stop)? */
  isRunning(plantId, machineId){
    const list = this.events.filter(e => e.plant === plantId && e.machine === machineId)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    let running = false;
    for(const e of list){
      if(e.type === "start") running = true;
      else if(e.type === "stop") running = false;
    }
    return running;
  },

  /* Pair start/stop events chronologically into total hours for a date.
   * Splits out the still-running segment (if any) so callers can update
   * a live on-screen timer without re-querying the database every tick. */
  hoursFromEvents(plantId, machineId, dateStr){
    const dayEvents = this.events
      .filter(e => e.plant === plantId && e.machine === machineId && e.timestamp.slice(0, 10) === dateStr)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    let baseHours = 0, startTs = null;
    for(const e of dayEvents){
      if(e.type === "start"){ startTs = new Date(e.timestamp); }
      else if(e.type === "stop" && startTs){
        baseHours += (new Date(e.timestamp) - startTs) / 3600000;
        startTs = null;
      }
    }
    const openStart = (startTs && dateStr === this.todayStr()) ? startTs : null;
    const liveHours = openStart ? (Date.now() - openStart) / 3600000 : 0;
    return { hours: baseHours + liveHours, baseHours, openStart, hasEvents: dayEvents.length > 0 };
  },

  hoursFromShifts(plantId, machineId, dateStr){
    return this.shifts
      .filter(s => s.plant === plantId && s.machine === machineId && s.date === dateStr)
      .reduce((sum, s) => sum + Number(s.hours || 0), 0);
  },

  /* Operating hours for one machine on one date: prefer the event log if
   * it has any entries that day, otherwise fall back to shift totals. */
  operatingHours(plantId, machineId, dateStr){
    const ev = this.hoursFromEvents(plantId, machineId, dateStr);
    if(ev.hasEvents) return ev.hours;
    return this.hoursFromShifts(plantId, machineId, dateStr);
  },

  /* Latest actual power reading for that machine/date, else rated kW. */
  powerForDate(plantId, machineId, dateStr, ratedKW){
    const dayReadings = this.readings
      .filter(r => r.plant === plantId && r.machine === machineId && r.date === dateStr)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    if(dayReadings.length) return Number(dayReadings[0].kW);
    return Number(ratedKW);
  },

  energyKWh(plantId, machineId, dateStr, ratedKW){
    const hours = this.operatingHours(plantId, machineId, dateStr);
    const kw = this.powerForDate(plantId, machineId, dateStr, ratedKW);
    return { hours, kw, kwh: hours * kw };
  },

  /* Same as energyKWh, but also returns the open start time (if the
   * machine is running right now) and the kWh already banked before this
   * run started, so the UI can tick the total up live without hitting
   * the database every second. */
  liveEnergyState(plantId, machineId, dateStr, ratedKW){
    const ev = this.hoursFromEvents(plantId, machineId, dateStr);
    const kw = this.powerForDate(plantId, machineId, dateStr, ratedKW);
    const baseHours = ev.hasEvents ? ev.baseHours : this.hoursFromShifts(plantId, machineId, dateStr);
    return {
      kw,
      baseKwh: baseHours * kw,
      openStart: ev.openStart, // Date or null
      kwh: (baseHours * kw) + (ev.openStart ? (Date.now() - ev.openStart) / 3600000 * kw : 0)
    };
  },

  dateRange(fromStr, toStr){
    const dates = [];
    let d = new Date(fromStr + "T00:00:00");
    const end = new Date(toStr + "T00:00:00");
    while(d <= end){
      dates.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
    return dates;
  },

  uid(prefix){
    const raw = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    return prefix ? `${prefix}-${raw}` : raw;
  },

  slugify(name){
    return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "plant";
  }
};
