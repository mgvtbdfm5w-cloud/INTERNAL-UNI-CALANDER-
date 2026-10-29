// Platinum Intake Board: static page + small JSON API with a password-protected admin.
// No dependencies. Data lives in DATA_DIR (mount a volume there in production).
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const SEED_DIR = ROOT; // board.json and assets.json sit next to this file
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const BOARD_FILE = path.join(DATA_DIR, "board.json");
const LOGO_DIR = path.join(DATA_DIR, "logos");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("pib:" + ADMIN_PASSWORD).digest("hex");
const SESSION_HOURS = 12;
const MAX_JSON = 256 * 1024;
const MAX_LOGO = 3 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const ASSET_RE = /^[a-f0-9]{32}$/;
const IMAGE_TYPES = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg" };
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

if (!ADMIN_PASSWORD) console.warn("[warn] ADMIN_PASSWORD is not set: the admin panel is disabled until you set it.");

// ---------- storage ----------
let board = null;
let writing = Promise.resolve();

function loadBoard() {
  fs.mkdirSync(LOGO_DIR, { recursive: true });
  if (!fs.existsSync(BOARD_FILE)) {
    fs.copyFileSync(path.join(SEED_DIR, "board.json"), BOARD_FILE);
    console.log("[init] seeded board from board.json");
  }
  board = JSON.parse(fs.readFileSync(BOARD_FILE, "utf8"));
  board.meta ||= {}; board.partners ||= {};
}
function saveBoard() {
  const snapshot = JSON.stringify(board, null, 2);
  writing = writing.then(async () => {
    const tmp = BOARD_FILE + ".tmp";
    await fsp.writeFile(tmp, snapshot);
    await fsp.rename(tmp, BOARD_FILE);
  });
  return writing;
}
// Seed images (partner logos and the Platinum logo) ship as data URIs in assets.json
const SEED_ASSETS = (() => { try { return JSON.parse(fs.readFileSync(path.join(SEED_DIR, "assets.json"), "utf8")); } catch { return {}; } })();
function seedAsset(key) {
  const v = SEED_ASSETS[key]; if (typeof v !== "string") return null;
  const m = v.match(/^data:([a-z0-9.+\/-]+);base64,(.*)$/i); if (!m) return null;
  return { type: m[1], data: Buffer.from(m[2], "base64") };
}
function findLogo(id) {
  for (const ext of Object.values(IMAGE_TYPES)) {
    const f = path.join(LOGO_DIR, id + ext);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// ---------- auth ----------
function sign(value) { return crypto.createHmac("sha256", SECRET).update(value).digest("base64url"); }
function makeToken() { const exp = Date.now() + SESSION_HOURS * 3600e3; return exp + "." + sign("admin:" + exp); }
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map(s => s.trim().split("=")).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
}
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const t = cookies(req).pib_admin || "";
  const [exp, sig] = t.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const want = Buffer.from(sign("admin:" + exp)), got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function passwordOk(p) {
  if (!ADMIN_PASSWORD || typeof p !== "string") return false;
  const a = crypto.createHash("sha256").update(p).digest(), b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}
const loginTries = new Map(); // ip -> { n, until }
function rateLimited(ip) {
  const r = loginTries.get(ip); return r && r.n >= 8 && r.until > Date.now();
}
function noteFailure(ip) {
  const r = loginTries.get(ip) || { n: 0, until: 0 };
  r.n = r.until > Date.now() ? r.n + 1 : 1; r.until = Date.now() + 15 * 60e3; loginTries.set(ip, r);
}

// ---------- http helpers ----------
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf ? body : typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({ "Content-Type": isBuf ? "application/octet-stream" : typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, headers));
  res.end(data);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", c => { size += c.length; if (size > limit) { reject(Object.assign(new Error("too_large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, MAX_JSON);
  let v; try { v = JSON.parse(buf.toString("utf8") || "null"); } catch { throw Object.assign(new Error("bad_json"), { status: 400 }); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Object.assign(new Error("bad_body"), { status: 400 });
  return v;
}
function sameOrigin(req) {
  const o = req.headers.origin; if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

// Only the page itself and the two brand logos are public; nothing else in this folder is served.
async function serveStatic(req, res, urlPath) {
  if (urlPath === "/" || urlPath === "/index.html") {
    return send(res, 200, await fsp.readFile(path.join(ROOT, "index.html")), { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
  }
  const name = urlPath.slice(1);
  if (name === "platinum-logo.png" || name === "platinum-logo-dark.png") {
    const a = seedAsset(name);
    if (a) return send(res, 200, a.data, { "Content-Type": a.type, "Cache-Control": "public, max-age=86400" });
  }
  send(res, 404, "Not found");
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname, m = req.method;
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";

  if (p === "/healthz") return send(res, 200, { ok: true });

  if (p === "/api/board" && m === "GET") {
    const partners = Object.entries(board.partners).map(([id, d]) => Object.assign({ id }, d));
    return send(res, 200, { meta: board.meta, partners });
  }
  if (p === "/api/session" && m === "GET") return send(res, 200, { admin: isAdmin(req), enabled: !!ADMIN_PASSWORD });

  if (p.startsWith("/_blob/") && (m === "GET" || m === "HEAD")) {
    const id = p.slice(7);
    if (!ASSET_RE.test(id)) return send(res, 404, "Not found");
    const f = findLogo(id);
    if (!f) { const a = seedAsset(id); return a ? send(res, 200, a.data, { "Content-Type": a.type, "Cache-Control": "public, max-age=31536000, immutable" }) : send(res, 404, "Not found"); }
    const ext = path.extname(f);
    return send(res, 200, await fsp.readFile(f), { "Content-Type": MIME[ext], "Cache-Control": "public, max-age=31536000, immutable", ...(ext === ".svg" ? { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } : {}) });
  }

  if (p.startsWith("/api/")) {
    if (m !== "GET" && !sameOrigin(req)) return send(res, 403, { error: "forbidden" });

    if (p === "/api/login" && m === "POST") {
      if (!ADMIN_PASSWORD) return send(res, 503, { error: "admin_disabled" });
      if (rateLimited(ip)) return send(res, 429, { error: "rate_limited" });
      const body = await readJson(req);
      if (!passwordOk(body.password)) { noteFailure(ip); return send(res, 401, { error: "wrong_password" }); }
      loginTries.delete(ip);
      const secure = (req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "";
      return send(res, 200, { admin: true }, { "Set-Cookie": `pib_admin=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}` });
    }
    if (p === "/api/logout" && m === "POST") return send(res, 200, { admin: false }, { "Set-Cookie": "pib_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });

    if (!isAdmin(req)) return send(res, 401, { error: "not_admin" });

    if (p === "/api/meta" && m === "PUT") {
      const body = await readJson(req);
      board.meta = body; await saveBoard();
      return send(res, 200, { ok: true });
    }
    const pm = p.match(/^\/api\/partners\/([^/]+)$/);
    if (pm) {
      const id = decodeURIComponent(pm[1]);
      if (!ID_RE.test(id)) return send(res, 400, { error: "bad_id" });
      if (m === "PUT") {
        const body = await readJson(req);
        if (typeof body.name !== "string" || !body.name.trim()) return send(res, 400, { error: "name_required" });
        delete body.id; board.partners[id] = body; await saveBoard();
        return send(res, 200, { ok: true });
      }
      if (m === "DELETE") { delete board.partners[id]; await saveBoard(); return send(res, 200, { ok: true }); }
    }
    if (p === "/api/assets" && m === "POST") {
      const type = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      const ext = IMAGE_TYPES[type]; if (!ext) return send(res, 415, { error: "unsupported_type" });
      const buf = await readBody(req, MAX_LOGO);
      if (!buf.length) return send(res, 400, { error: "empty" });
      const id = crypto.randomBytes(16).toString("hex");
      await fsp.writeFile(path.join(LOGO_DIR, id + ext), buf);
      return send(res, 200, { id, url: "/_blob/" + id, sizeBytes: buf.length, contentType: type });
    }
    const am = p.match(/^\/api\/assets\/([a-f0-9]{32})$/);
    if (am && m === "DELETE") {
      const inUse = Object.values(board.partners).some(x => x.logo === am[1]);
      if (!inUse) for (const ext of Object.values(IMAGE_TYPES)) await fsp.rm(path.join(LOGO_DIR, am[1] + ext), { force: true });
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "not_found" });
  }

  if (m === "GET" || m === "HEAD") return serveStatic(req, res, p);
  send(res, 405, "Method not allowed");
}

loadBoard();
http.createServer((req, res) => {
  handle(req, res).catch(err => {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: err.message === "too_large" ? "too_large" : status === 500 ? "server_error" : err.message });
  });
}).listen(PORT, () => console.log(`Platinum Intake Board on :${PORT} (data in ${DATA_DIR})`));
