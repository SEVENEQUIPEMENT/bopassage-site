import { loadState, saveState, sync, resolveIds, recentPosts, publishLaunch, tiersFor, PLATFORMS, LAUNCH_TEXTS, gget, gpost } from "./_lib.mjs";
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const pub = (st) => ({
  tiers: { Instagram: tiersFor("Instagram", st.config), Facebook: tiersFor("Facebook", st.config) }, platforms: PLATFORMS, counts: st.counts, lastError: st.lastError,
  log: st.log.slice(-200),
  draws: Object.fromEntries(Object.entries(st.draws).map(([k, d]) => [k, d.pending ? { pending: true, reason: d.reason } : { ...d, participants: d.participants, winner: { name: d.winner.name } }])),
  config: { autoPost: st.config.autoPost, requireTag: st.config.requireTag, enabled: st.config.enabled, igMediaId: st.config.igMediaId || "", fbPostId: st.config.fbPostId || "", igMediaIds: st.config.igMediaIds || [], fbPostIds: st.config.fbPostIds || [], manual: st.config.manual || { Instagram: [], Facebook: [] }, igUsername: st.config.igUsername, fbPageName: st.config.fbPageName, tiers: st.config.tiers },
});
export default async (req) => {
  try { return await handle(req); } catch (e) { return J({ error: e.message }, 500); }
};
async function handle(req) {
  if (req.method === "GET") return J(pub(await loadState()));
  if (req.method !== "POST") return J({ error: "méthode" }, 405);
  const body = await req.json().catch(() => ({}));
  if (!process.env.ADMIN_SECRET || body.secret !== process.env.ADMIN_SECRET) return J({ error: "non autorisé" }, 401);
  let st = await loadState();
  if (body.action === "config") { st.config = { ...st.config, ...body.config }; await saveState(st); }
  if (body.action === "reset-draw" && body.key) { delete st.draws[body.key]; await saveState(st); }
  if (body.action === "sync") { st = (await sync({ force: true })).state; }
  if (body.action === "posts") { await resolveIds(st.config); await saveState(st); const posts = await recentPosts(st.config); return J({ ok: true, posts }); }
  if (body.action === "post-fb") {
    await resolveIds(st.config);
    const fb = await gpost(`/${st.config.fbPageId}/photos`, { url: body.image, message: body.text || "" }, st.config.fbPageToken);
    return J({ ok: true, fbPostId: fb.post_id || fb.id });
  }
  if (body.action === "post-ig") {
    await resolveIds(st.config);
    if (!st.config.igPendingCustom) {
      const c = await gpost(`/${st.config.igUserId}/media`, { image_url: body.image, caption: body.text || "" });
      st.config.igPendingCustom = c.id; await saveState(st);
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      const r = await gget(`/${st.config.igPendingCustom}`, { fields: "status_code,status" });
      if (r.status_code === "FINISHED") {
        const pm = await gpost(`/${st.config.igUserId}/media_publish`, { creation_id: st.config.igPendingCustom });
        st.config.igPendingCustom = ""; await saveState(st);
        return J({ ok: true, done: true, igMediaId: pm.id });
      }
      if (r.status_code === "ERROR") { st.config.igPendingCustom = ""; await saveState(st); return J({ error: "Instagram a refusé l'image : " + (r.status || "") }, 500); }
      await new Promise(r => setTimeout(r, 1500));
    }
    return J({ ok: true, done: false });
  }
  if (body.action === "launch-fb") {
    await resolveIds(st.config);
    const img = "https://bopassage.fr/img/jeu/lancement-carre.jpg";
    const fb = await gpost(`/${st.config.fbPageId}/photos`, { url: img, message: LAUNCH_TEXTS.Facebook }, st.config.fbPageToken);
    st.config = { ...st.config, fbPostId: fb.post_id || fb.id, fbPostIds: [...new Set([...(st.config.fbPostIds || []), fb.post_id || fb.id])] };
    for (const k of Object.keys(st.draws)) if (st.draws[k].pending && k.startsWith("Facebook")) delete st.draws[k];
    await saveState(st);
    return J({ ok: true, fbPostId: st.config.fbPostId, ...pub(st) });
  }
  if (body.action === "launch-ig") {
    await resolveIds(st.config);
    const img = "https://bopassage.fr/img/jeu/lancement-carre.jpg";
    if (!st.config.igPendingContainer) {
      const c = await gpost(`/${st.config.igUserId}/media`, { image_url: img, caption: LAUNCH_TEXTS.Instagram });
      st.config.igPendingContainer = c.id; await saveState(st);
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      const r = await gget(`/${st.config.igPendingContainer}`, { fields: "status_code,status" });
      if (r.status_code === "FINISHED") {
        const pmedia = await gpost(`/${st.config.igUserId}/media_publish`, { creation_id: st.config.igPendingContainer });
        st.config = { ...st.config, igMediaId: pmedia.id, igMediaIds: [...new Set([...(st.config.igMediaIds || []), pmedia.id])], igPendingContainer: "" };
        for (const k of Object.keys(st.draws)) if (st.draws[k].pending && k.startsWith("Instagram")) delete st.draws[k];
        await saveState(st);
        return J({ ok: true, done: true, igMediaId: pmedia.id, ...pub(st) });
      }
      if (r.status_code === "ERROR") { st.config.igPendingContainer = ""; await saveState(st); return J({ error: "Instagram a refusé l'image : " + (r.status || "") }, 500); }
      await new Promise(r => setTimeout(r, 1500));
    }
    return J({ ok: true, done: false, message: "Instagram traite encore l'image…" });
  }
  if (body.action === "publish-launch") {
    await resolveIds(st.config);
    const ids = await publishLaunch(st.config, body.texts || LAUNCH_TEXTS, body.opts || {});
    st.config = { ...st.config, ...(ids.igMediaId ? { igMediaId: ids.igMediaId } : {}), ...(ids.fbPostId ? { fbPostId: ids.fbPostId } : {}) };
    for (const k of Object.keys(st.draws)) if (st.draws[k].pending) delete st.draws[k];
    await saveState(st);
    return J({ ok: true, ids, ...pub(st) });
  }
  if (body.action === "setCounts") { st.counts = { ...st.counts, ...body.counts, at: new Date().toISOString() }; await saveState(st); }
  return J({ ok: true, ...pub(st) });
}
