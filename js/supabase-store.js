/* supabase-store.js
 * Thin wrapper around the Supabase JS client. This is the app's only
 * point of contact with the database — no tokens, no per-user auth screen
 * for saving data. Reads and writes both go straight through with the
 * public anon key; Row Level Security in supabase/schema.sql decides what
 * that key is allowed to touch.
 */
const DB = {
  client: window.supabase.createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseAnonKey),
  channel: null,

  async select(table, { order } = {}){
    let q = this.client.from(table).select("*");
    if(order) q = q.order(order.column, { ascending: order.ascending !== false });
    const { data, error } = await q;
    if(error) throw error;
    return data || [];
  },

  async insert(table, row){
    const { error } = await this.client.from(table).insert(row);
    if(error) throw error;
  },

  async update(table, match, patch){
    let q = this.client.from(table).update(patch);
    Object.entries(match).forEach(([k, v]) => { q = q.eq(k, v); });
    const { error } = await q;
    if(error) throw error;
  },

  async remove(table, match){
    let q = this.client.from(table).delete();
    Object.entries(match).forEach(([k, v]) => { q = q.eq(k, v); });
    const { error } = await q;
    if(error) throw error;
  },

  async rpc(fn, args){
    const { data, error } = await this.client.rpc(fn, args);
    if(error) throw error;
    return data;
  },

  /* Live updates: fires `onChange` whenever events/readings change in the
   * database, from ANY device. This is what makes the dashboard genuinely
   * real-time instead of only polling every N seconds. `onStatus` (optional)
   * reports the socket's real state (SUBSCRIBED / CHANNEL_ERROR / TIMED_OUT /
   * CLOSED) so the UI's "Live" indicator reflects reality instead of just
   * being decorative. */
  subscribeLive(onChange, onStatus){
    if(this.channel) this.client.removeChannel(this.channel);
    this.channel = this.client
      .channel("feedmix-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "events" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "readings" }, onChange)
      .subscribe(status => { if(onStatus) onStatus(status); });
    return this.channel;
  },

  unsubscribeLive(){
    if(this.channel){ this.client.removeChannel(this.channel); this.channel = null; }
  }
};
