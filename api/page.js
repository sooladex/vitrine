// Rendu serveur des vitrines publiques (/pseudo) : titre, aperçu social et données de la page.
const fs = require('fs');
const path = require('path');
const { sql, SITE, SLUG_RE, ensureSchema } = require('./_lib');

let TEMPLATE = null;
const template = () => TEMPLATE || (TEMPLATE = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8'));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const forScript = o => JSON.stringify(o).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function head({ title, desc, url, image, robots, jsonld }) {
  return `<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">
<meta name="robots" content="${robots}">
<meta property="og:type" content="profile">
<meta property="og:site_name" content="Vitrine">
<meta property="og:locale" content="fr_FR">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
${image ? `<meta property="og:image" content="${esc(image)}">\n<meta name="twitter:image" content="${esc(image)}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
${jsonld ? `<script type="application/ld+json">${forScript(jsonld)}</script>` : ''}`;
}

module.exports = async (req, res) => {
  const slug = String((req.query && req.query.slug) || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  let html = template(), row = null, dbError = false;
  if (SLUG_RE.test(slug)) {
    try { await ensureSchema(); row = (await sql`select slug, config, updated_at from pages where slug = ${slug}`)[0] || null; }
    catch (e) { dbError = true; console.error('[vitrine page]', e && e.message); }
  }
  const url = `${SITE}/${slug}`;
  if (row) {
    const c = row.config || {};
    const name = clip(c.name || row.slug, 40);
    const prods = (Array.isArray(c.products) ? c.products : []).filter(p => p && p.url);
    const titles = prods.map(p => clip(p.title, 30)).filter(Boolean).slice(0, 4).join(', ');
    const desc = clip(c.bio ? `${c.bio} — ${prods.length} sites sur Vitrine.` : `Tous les sites de ${name}${titles ? ' : ' + titles : ''}.`, 158);
    const first = prods.find(p => p.feat) || prods[0];
    html = html.replace(/<!--SEO-->[\s\S]*?<!--\/SEO-->/, head({
      title: `${name} (@${row.slug}) · Vitrine`, desc, url, robots: 'index,follow,max-image-preview:large',
      image: first ? `${SITE}/api/shot?u=${encodeURIComponent(first.url)}` : `${SITE}/og.png`,
      jsonld: { '@context': 'https://schema.org', '@type': 'ProfilePage', url, name: `${name} (@${row.slug})`, dateModified: row.updated_at,
        mainEntity: { '@type': 'Person', name, alternateName: '@' + row.slug, description: c.bio || undefined,
          owns: prods.slice(0, 20).map(p => ({ '@type': 'WebSite', name: p.title || p.url, url: p.url, description: p.desc || undefined })) } }
    })).replace('<!--DATA-->', `<script>window.__PAGE__=${forScript({ slug: row.slug, config: c })};</script>`);
    res.statusCode = 200;
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
  } else {
    html = html.replace(/<!--SEO-->[\s\S]*?<!--\/SEO-->/, head({
      title: SLUG_RE.test(slug) ? `@${slug} est libre · Vitrine` : 'Page introuvable · Vitrine',
      desc: 'Cette vitrine n’existe pas encore. Réserve ce pseudo et montre tous tes sites avec leur vrai aperçu.',
      url, image: `${SITE}/og.png`, robots: 'noindex,follow', jsonld: null
    })).replace('<!--DATA-->', `<script>window.__PAGE__=${forScript({ slug, missing: true })};</script>`);
    res.statusCode = dbError ? 503 : 404;
    res.setHeader('Cache-Control', dbError ? 'no-store' : 'public, s-maxage=30');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
};
