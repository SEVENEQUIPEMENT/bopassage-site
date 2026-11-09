import { loadState, saveState, sync, resolveIds, recentPosts, TIERS, PLATFORMS } from "./_lib.mjs";
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const pub = (st) => ({
  tiers: TIERS, platforms: PLATFORMS, counts: st.counts, lastError: st.lastError,
  log: st.log.slice(-200),
  draws: Object.fromEntries(Object.entries(st.draws).map(([k, d]) => [k, d.pending ? { pending: true, reason: d.reason } : { ...d, participants: d.participants, winner: { name: d.winner.name } }])),
  config: { autoPost: st.config.autoPost, requireTag: st.config.requireTag, enabled: st.config.enabled, igMediaId: st.config.igMediaId || "", fbPostId: st.config.fbPostId || "", igUsername: st.config.igUsername, fbPageName: st.config.fbPageName },
});
export default async (req) => {
  if (req.method === "GET") return J(pub(await loadState()));
  if (req.method !== "POST") return J({ error: "méthode" }, 405);
  const body = await req.json().catch(() => ({}));
  if (!process.env.ADMIN_SECRET || body.secret !== process.env.ADMIN_SECRET) return J({ error: "non autorisé" }, 401);
  let st = await loadState();
  if (body.action === "config") { st.config = { ...st.config, ...body.config }; await saveState(st); }
  if (body.action === "reset-draw" && body.key) { delete st.draws[body.key]; await saveState(st); }
  if (body.action === "sync") { st = (await sync({ force: true })).state; }
  if (body.action === "posts") { await resolveIds(st.config); await saveState(st); const posts = await recentPosts(st.config); return J({ ok: true, posts }); }
  if (body.action === "setCounts") { st.counts = { ...st.counts, ...body.counts, at: new Date().toISOString() }; await saveState(st); }
  return J({ ok: true, ...pub(st), fullConfig: st.config });
};
