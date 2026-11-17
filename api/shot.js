// Vrai aperçu d'un site : GET /api/shot?u=<adresse>
// Capture par Microlink (repli : thum.io), gardée 7 jours en base pour ne pas la refaire à chaque visite.
const { sql, ensureSchema, currentUser, cleanUrl } = require('./_lib');

const FRESH_MS = 7 * 24 * 3600 * 1000;
const MAX_BYTES = 3 * 1024 * 1024;

async function grab(src, headers) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 22000);
  try {
    const r = await fetch(src, { headers: headers || {}, redirect: 'follow', signal: ctl.signal });
    const type = (r.headers.get('content-type') || '').split(';')[0];
    if (!r.ok || !/^image\/(jpeg|png|webp)$/.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 2000 || buf.length > MAX_BYTES) return null;
    return { mime: type, buf };
  } catch (e) { return null; } finally { clearTimeout(t); }
}

async function capture(url) {
  const key = process.env.MICROLINK_API_KEY;
  const q = new URLSearchParams({
    url, screenshot: 'true', meta: 'false', embed: 'screenshot.url',
    'screenshot.type': 'jpeg', 'viewport.width': '1280', 'viewport.height': '800', waitForTimeout: '6000'
  });
  return (await grab(`https://${key ? 'pro' : 'api'}.microlink.io/?${q}`, key ? { 'x-api-key': key } : null))
      || (await grab(`https://image.thum.io/get/width/1280/crop/800/noanimate/${url}`));
}

const LONG = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';
function send(res, mime, buf, cache) {
  res.statusCode = 200;
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', cache);
  res.end(buf);
}
function fail(res, code) { res.statusCode = code; res.setHeader('Cache-Control', 'no-store'); res.end(); }

module.exports = async (req, res) => {
  const url = cleanUrl(req.query && req.query.u);
  if (!url) return fail(res, 400);
  try {
    await ensureSchema();
    const row = (await sql`select mime, encode(data, 'base64') as b64, fetched_at from shots where url = ${url}`)[0];
    const refresh = req.query && req.query.refresh === '1' && (await currentUser(req));
    if (row && !refresh && Date.now() - new Date(row.fetched_at).getTime() < FRESH_MS) return send(res, row.mime, Buffer.from(row.b64, 'base64'), LONG);

    // Seulement les sites présents sur une vitrine, ou demandés par quelqu'un de connecté (éditeur).
    const listed = (await sql`select 1 from pages where config->'products' @> ${JSON.stringify([{ url }])}::jsonb limit 1`).length > 0;
    if (!listed && !(await currentUser(req))) return fail(res, 404);

    const shot = await capture(url);
    if (shot) {
      await sql`insert into shots (url, mime, data, fetched_at) values (${url}, ${shot.mime}, decode(${shot.buf.toString('base64')}, 'base64'), now())
                on conflict (url) do update set mime = excluded.mime, data = excluded.data, fetched_at = now()`;
      return send(res, shot.mime, shot.buf, LONG);
    }
    if (row) return send(res, row.mime, Buffer.from(row.b64, 'base64'), 'public, max-age=600, s-maxage=3600');
    return fail(res, 502);
  } catch (e) {
    console.error('[vitrine shot]', e && e.message);
    return fail(res, 503);
  }
};
