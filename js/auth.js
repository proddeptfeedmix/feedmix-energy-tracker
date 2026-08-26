/* auth.js - username/password auth with roles: admin | technician
 * Password checking and hashing both happen inside Postgres (see the
 * login() and admin_add_user() functions in supabase/schema.sql) — the
 * browser never sees a password hash, only a yes/no plus the safe session
 * fields. NOTE: this is "simple auth" suitable for a small trusted internal
 * team, not a hardened identity system.
 */
const AUTH = {
  session: null, // { username, name, role, plant }

  async login(username, password){
    let rows;
    try{
      rows = await DB.rpc("login", { p_username: username, p_password: password });
    }catch(e){
      throw new Error("Could not reach the server. Check js/config.js (supabaseUrl/supabaseAnonKey) and your connection.");
    }
    if(!rows || rows.length === 0) throw new Error("Invalid username or password.");
    const u = rows[0];
    this.session = { username: u.username, name: u.name, role: u.role, plant: u.plant_id || null };
    sessionStorage.setItem("feedmix_session", JSON.stringify(this.session));
    return this.session;
  },

  restoreSession(){
    const raw = sessionStorage.getItem("feedmix_session");
    if(!raw) return null;
    this.session = JSON.parse(raw);
    return this.session;
  },

  logout(){
    this.session = null;
    sessionStorage.removeItem("feedmix_session");
  },

  isAdmin(){ return this.session && this.session.role === "admin"; },

  /* Which plant IDs the current user may enter data for. Admin = all. */
  allowedPlants(plants){
    if(this.isAdmin()) return plants.map(p => p.id);
    return this.session && this.session.plant ? [this.session.plant] : [];
  }
};
