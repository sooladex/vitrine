// Outils partagés des fonctions serveur de Vitrine (non exposé : préfixe « _ »).
const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);
const SITE = (process.env.SITE_URL || 'https://vitrine.sooladex.com').replace(/\/$/, '');
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{2,29}$/;
const RESERVED = new Set(['app','api','admin','edit','editer','login','connexion','signup','inscription','compte','account','settings','vitrine','www','help','aide','about','terms','privacy','static','assets','media','m','u','new','dashboard','explore','shot']);
const COOKIE = 'vit_s';
const SESSION_DAYS = 60;
const STATUSES = ['live', 'beta', 'soon', 'sale', 'app', 'archive'];

// Les tables sont créées au premier appel : il suffit de brancher une base Neon vide.
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) schemaReady = (async () => {
    await sql`create table if not exists users (id text primary key, email text unique not null, pass_hash text not null, created_at timestamptz not null default now())`;
    await sql`create table if not exists sessions (token_hash text primary key, user_id text not null references users(id) on delete cascade, expires_at timestamptz not null)`;
    await sql`create table if not exists pages (id text primary key, user_id text unique not null references users(id) on delete cascade, slug text unique not null, config jsonb not null default '{}'::jsonb, views integer not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
    await sql`create table if not exists shots (url text primary key, mime text not null, data bytea not null, fetched_at timestamptz not null default now())`;
  })().catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const ref = Buffer.from(hashHex, 'hex');
  return ref.length === h.length && crypto.timingSafeEqual(ref, h);
}
const sha = t => crypto.createHash('sha256').update(t).digest('hex');

function readCookie(req, name) {
  const m = String(req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
async function newSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await sql`insert into sessions (token_hash, user_id, expires_at) values (${sha(token)}, ${userId}, now() + make_interval(days => ${SESSION_DAYS}))`;
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
async function currentUser(req) {
  const t = readCookie(req, COOKIE); if (!t) return null;
  const rows = await sql`select u.id, u.email from sessions s join users u on u.id = s.user_id where s.token_hash = ${sha(t)} and s.expires_at > now()`;
  return rows[0] || null;
}

function slugProblem(s) {
  if (!s) return 'Choisis un pseudo.';
  if (s.length < 3) return '3 caractères minimum.';
  if (!SLUG_RE.test(s)) return 'Lettres minuscules, chiffres, - et _ seulement.';
  if (RESERVED.has(s)) return 'Ce pseudo est réservé.';
  return '';
}

// Adresse publique http(s) d'un site, forme normalisée (sert de clé aux captures).
function cleanUrl(u) {
  u = String(u || '').trim(); if (!u || u.length > 500) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  try {
    const p = new URL(u);
    if (!['http:', 'https:'].includes(p.protocol)) return '';
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/i.test(p.hostname) || !p.hostname.includes('.')) return '';
    return p.href;
  } catch (e) { return ''; }
}

const HEX = /^#[0-9a-f]{6}$/i;
const s = (v, n) => String(v == null ? '' : v).slice(0, n);
// Nettoie la config d'une page avant enregistrement.
function cleanConfig(c) {
  c = (c && typeof c === 'object') ? c : {};
  return {
    name: s(c.name, 40), bio: s(c.bio, 180),
    c1: HEX.test(c.c1) ? c.c1 : '#7c5cff', c2: HEX.test(c.c2) ? c.c2 : '#00d4ff',
    intro: c.intro !== false,
    socials: (Array.isArray(c.socials) ? c.socials : []).slice(0, 6).map(x => ({ label: s(x && x.label, 24), url: cleanUrl(x && x.url) })).filter(x => x.label && x.url),
    products: (Array.isArray(c.products) ? c.products : []).slice(0, 40).map(x => ({
      title: s(x && x.title, 60), url: cleanUrl(x && x.url), desc: s(x && x.desc, 160),
      cat: s(x && x.cat, 30), status: STATUSES.includes(x && x.status) ? x.status : 'live', feat: !!(x && x.feat),
      v: Number.isFinite(+(x && x.v)) ? Math.max(0, Math.floor(+x.v)) : 0
    }))
  };
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

module.exports = { sql, SITE, SLUG_RE, RESERVED, COOKIE, ensureSchema, hashPassword, checkPassword, sha, readCookie, newSession, clearSession, currentUser, slugProblem, cleanUrl, cleanConfig, json };
