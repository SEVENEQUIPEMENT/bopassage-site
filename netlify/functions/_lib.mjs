import { getStore } from "@netlify/blobs";

export const TIERS = [
  { n: 300,  title: "Apéritif pour deux",            sub: "valeur 24 €" },
  { n: 500,  title: "Planche Découverte",            sub: "valeur 25 €" },
  { n: 700,  title: "Bouteille de Rosé pétillant",   sub: "Domaine des 7 Parcelles · à partager entre ami(e)s" },
  { n: 1000, title: "Repas pour deux",               sub: "valeur 52 €" },
];
export const PLATFORMS = ["Instagram", "Facebook"];
export const DEFAULT_TIERS = { Instagram: [300, 500, 700, 1000], Facebook: [500, 700, 1000, 1200] };
/** Paliers d'un réseau (les 4 lots dans l'ordre, seuils configurables). */
export function tiersFor(platform, cfg) {
  const ns = (cfg?.tiers && cfg.tiers[platform]) || DEFAULT_TIERS[platform];
  return TIERS.map((t, i) => ({ ...t, n: ns[i] ?? t.n }));
}
const G = "https://graph.facebook.com/v21.0";

export const store = () => getStore({ name: "jeu", consistency: "strong" });

export async function loadState() {
  const s = store();
  const st = (await s.get("state", { type: "json" })) || {};
  return {
    counts: st.counts || { Instagram: null, Facebook: null, at: null },
    log: st.log || [],                // [{at, Instagram, Facebook}]
    draws: st.draws || {},            // {"Instagram-300": {...}}
    config: { igMediaId: "", fbPostId: "", autoPost: true, requireTag: false, enabled: true, tiers: DEFAULT_TIERS, ...(st.config || {}) },
    lastError: st.lastError || null,
  };
}
export const saveState = (st) => store().setJSON("state", st);

export function token() {
  const t = process.env.META_PAGE_TOKEN;
  if (!t) throw new Error("META_PAGE_TOKEN manquant");
  return t;
}
export async function gget(path, params = {}, tok) {
  const u = new URL(G + path);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  u.searchParams.set("access_token", tok || token());
  const r = await fetch(u);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error("Graph " + path + " : " + (j.error?.message || r.status));
  return j;
}
export async function gpost(path, params = {}, tok) {
  const u = new URL(G + path);
  const body = new URLSearchParams({ ...params, access_token: tok || token() });
  const r = await fetch(u, { method: "POST", body });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error("Graph POST " + path + " : " + (j.error?.message || r.status));
  return j;
}

/** Résout automatiquement l'ID de la page FB et du compte IG à partir du token (mis en cache dans la config). */
export async function resolveIds(cfg) {
  if (cfg.fbPageId && cfg.igUserId && cfg.fbPageToken) return cfg;
  if (cfg.fbPageId && cfg.igUserId) { const r = await gget(`/${cfg.fbPageId}`, { fields: "access_token" }); cfg.fbPageToken = r.access_token; return cfg; }
  const pages = await gget(`/me/accounts`, { fields: "id,name,instagram_business_account{id,username}", limit: 50 });
  let page = (pages.data || []).find(p => /b[oô]\s*passage/i.test(p.name)) || (pages.data || [])[0];
  if (!page) {
    // utilisateur système : passer par le portefeuille business
    const biz = await gget(`/me/businesses`, { fields: "id,name" });
    for (const b of biz.data || []) {
      const r = await gget(`/${b.id}/owned_pages`, { fields: "id,name,instagram_business_account{id,username}", limit: 50 });
      page = (r.data || []).find(p => /b[oô]\s*passage/i.test(p.name)) || (r.data || [])[0];
      if (page) break;
    }
  }
  if (!page) throw new Error("Aucune page Facebook accessible avec ce token");
  cfg.fbPageId = page.id; cfg.fbPageName = page.name;
  cfg.igUserId = page.instagram_business_account?.id || "";
  cfg.igUsername = page.instagram_business_account?.username || "";
  if (!cfg.igUserId) throw new Error("Aucun compte Instagram professionnel relié à la page " + page.name);
  const r = await gget(`/${cfg.fbPageId}`, { fields: "access_token" }); cfg.fbPageToken = r.access_token;
  return cfg;
}
export async function fetchCounts(cfg) {
  const ig = await gget(`/${cfg.igUserId}`, { fields: "followers_count,username" });
  const fb = await gget(`/${cfg.fbPageId}`, { fields: "followers_count,fan_count,name" }, cfg.fbPageToken);
  return { Instagram: ig.followers_count, Facebook: fb.followers_count ?? fb.fan_count, igUser: ig.username, fbName: fb.name, at: new Date().toISOString() };
}
/** Derniers posts de chaque réseau, pour choisir le post concours. */
export async function recentPosts(cfg) {
  const ig = await gget(`/${cfg.igUserId}/media`, { fields: "id,caption,permalink,timestamp,comments_count", limit: 15 });
  const fb = await gget(`/${cfg.fbPageId}/posts`, { fields: "id,message,permalink_url,created_time,comments.summary(true).limit(0)", limit: 15 }, cfg.fbPageToken);
  return {
    Instagram: (ig.data || []).map(m => ({ id: m.id, text: (m.caption || "").slice(0, 120), url: m.permalink, at: m.timestamp, comments: m.comments_count })),
    Facebook: (fb.data || []).map(m => ({ id: m.id, text: (m.message || "").slice(0, 120), url: m.permalink_url, at: m.created_time, comments: m.comments?.summary?.total_count })),
  };
}

async function paginate(first) {
  let url = first, out = [];
  for (let i = 0; i < 40 && url; i++) {
    const r = await fetch(url); const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    out.push(...(j.data || []));
    url = j.paging?.next || null;
  }
  return out;
}
export async function participants(platform, cfg) {
  const t = token();
  let list = [];
  if (platform === "Instagram") {
    if (!cfg.igMediaId) throw new Error("Post concours Instagram non défini");
    const raw = await paginate(`${G}/${cfg.igMediaId}/comments?fields=username,text,timestamp&limit=100&access_token=${t}`);
    list = raw.filter(c => c.username !== cfg.igUsername).map(c => ({ id: c.username, name: "@" + c.username, text: c.text || "", tagged: /@[\w.]+/.test(c.text || "") }));
  } else {
    if (!cfg.fbPostId) throw new Error("Post concours Facebook non défini");
    const raw = await paginate(`${G}/${cfg.fbPostId}/comments?fields=from{name,id},message,message_tags,created_time&limit=100&filter=stream&access_token=${cfg.fbPageToken}`);
    list = raw.filter(c => c.from && c.from.id !== cfg.fbPageId).map(c => ({ id: c.from.id, name: c.from.name, text: c.message || "", tagged: (c.message_tags || []).length > 0 }));
  }
  const total = list.length;
  if (cfg.requireTag) list = list.filter(p => p.tagged);
  const seen = new Set(); const uniq = [];
  for (const p of list) { if (!seen.has(p.id)) { seen.add(p.id); uniq.push({ id: p.id, name: p.name }); } }
  uniq.totalComments = total;
  return uniq;
}

export function randomIndex(n) {
  const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n;
}

export async function publishWinner(platform, tier, winner, cfg) {
  const t = tiersFor(platform, cfg).find(x => x.n === tier);
  const msg = `🎉 Palier ${tier} abonnés atteint sur ${platform} ! Bravo ${winner.name}, tu remportes : ${t.title} (${t.sub}) au Bô Passage. Envoie-nous un message privé pour récupérer ton lot.\n\nMerci à tous les participants — le jeu continue jusqu'à 1000 abonnés, l'équipe de Bô Passage vous attend ! 🥂\n👉 Tirage vérifiable sur https://bopassage.fr/jeu`;
  if (platform === "Facebook") {
    const r = await gpost(`/${cfg.fbPageId}/feed`, { message: msg, link: "https://bopassage.fr/jeu" }, cfg.fbPageToken);
    return r.id;
  } else {
    const idx = tiersFor(platform, cfg).findIndex(x => x.n === tier);
    const img = `https://bopassage.fr/img/jeu/gagnant-${[300,500,700,1000][idx] || 1000}.jpg`;
    return igPublish(cfg, img, msg);
  }
}

/** Vérifie les paliers et tire au sort si nécessaire. Renvoie la liste des nouveaux tirages. */
export async function sync({ force = false } = {}) {
  const st = await loadState();
  const news = [];
  try {
    await resolveIds(st.config);
    const counts = await fetchCounts(st.config);
    st.counts = counts;
    st.log.push({ at: counts.at, Instagram: counts.Instagram, Facebook: counts.Facebook });
    if (st.log.length > 2000) st.log = st.log.slice(-2000);
    if (st.config.enabled !== false) {
      for (const platform of PLATFORMS) {
        for (const t of tiersFor(platform, st.config)) {
          const key = `${platform}-${t.n}`;
          if (st.draws[key] && !st.draws[key].pending) continue;
          if ((counts[platform] ?? 0) < t.n) continue;
          try {
            const parts = await participants(platform, st.config);
            if (parts.length < 2) { st.draws[key] = { pending: true, reason: `${parts.totalComments || 0} commentaire(s) lu(s), ${parts.length} participant(s) valide(s) — il en faut au moins 2${st.config.requireTag ? " (option « ami tagué » active)" : ""}`, at: counts.at }; continue; }
            const idx = randomIndex(parts.length);
            const draw = { platform, tier: t.n, prize: t.title, sub: t.sub, at: new Date().toISOString(), followers: counts[platform],
              participants: parts.map(p => p.name), index: idx, winner: parts[idx], turns: 6 + randomIndex(3), posted: null };
            if (st.config.autoPost !== false) {
              try { draw.posted = await publishWinner(platform, t.n, parts[idx], st.config); } catch (e) { draw.postError = e.message; }
            }
            st.draws[key] = draw; news.push(draw);
          } catch (e) { st.draws[key] = { pending: true, reason: e.message, at: counts.at }; }
        }
      }
    }
    st.lastError = null;
  } catch (e) { st.lastError = { at: new Date().toISOString(), message: e.message }; }
  await saveState(st);
  return { state: st, news };
}

/** Publie le post de lancement sur FB et IG et l'enregistre comme post concours. */
/** Attend que le conteneur IG soit prêt puis publie. */
export async function igPublish(cfg, imageUrl, caption) {
  const c = await gpost(`/${cfg.igUserId}/media`, { image_url: imageUrl, caption });
  for (let i = 0; i < 15; i++) {
    const st = await gget(`/${c.id}`, { fields: "status_code,status" });
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR") throw new Error("Conteneur Instagram en erreur : " + (st.status || ""));
    await new Promise(r => setTimeout(r, 1500));
  }
  const p = await gpost(`/${cfg.igUserId}/media_publish`, { creation_id: c.id });
  return p.id;
}
export async function publishLaunch(cfg, texts, opts = {}) {
  const out = {};
  const img = "https://bopassage.fr/img/jeu/lancement-carre.jpg";
  if (!opts.skipFacebook) {
    const fb = await gpost(`/${cfg.fbPageId}/photos`, { url: img, message: texts.Facebook }, cfg.fbPageToken);
    out.fbPostId = fb.post_id || fb.id;
  }
  if (!opts.skipInstagram) out.igMediaId = await igPublish(cfg, img, texts.Instagram);
  return out;
}
