// Industry news scanner: pulls official UK sources once a day and keeps only items that
// affect higher education students who qualify for UK student finance (home fee status).
// International-student, visa and school-only items are filtered out. New items wait for
// admin review before they appear on the board.
"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const UA = "PlatinumIntakeBoard/1.0 (+news scanner)";
const MAX_AGE_DAYS = 180;        // ignore anything older than this
const SCAN_HOUR_UK = 7;          // daily scan after 07:00 UK time

// ---------- sources ----------
const GOVUK_ORGS = ["department-for-education", "student-loans-company", "hm-treasury", "office-for-students"];
const GOVUK_QUERIES = [
  "student finance", "student loan", "tuition fees", "maintenance loan", "maintenance grant",
  "higher education", "university funding", "lifelong learning entitlement", "Office for Students",
  "student support regulations", "disabled students allowance", "postgraduate loan", "fee status", "franchised provision"
];
const SKIP_DOC_TYPES = new Set(["transparency", "form", "foi_release", "official_statistics_announcement", "national_statistics_announcement",
  "statistics_announcement", "official_statistics", "national_statistics", "document_collection", "corporate_report", "procurement", "organisation", "person", "ministerial_role", "service_manual_guide", "html_publication"]);
const LEGISLATION_FEEDS = [
  "https://www.legislation.gov.uk/all/data.feed?title=student&sort=published",
  "https://www.legislation.gov.uk/all/data.feed?title=higher%20education&sort=published",
  "https://www.legislation.gov.uk/all/data.feed?title=tuition&sort=published",
  "https://www.legislation.gov.uk/all/data.feed?title=lifelong%20learning&sort=published"
];

// ---------- relevance rules ----------
const HE_TERMS = [
  /student (finance|loans?|support|fees?|awards?)/i, /tuition fees?/i, /maintenance (loans?|grants?)/i, /higher education/i,
  /\buniversit(y|ies)\b/i, /\bundergraduate/i, /postgraduate (master'?s )?loans?/i, /doctoral loans?/i, /lifelong learning/i, /\bLLE\b/,
  /office for students/i, /\bOfS\b/, /disabled students'? allowances?/i, /\bDSA\b/, /higher technical/i, /\bHTQs?\b/, /degree apprenticeship/i,
  /fee status/i, /home fee/i, /student support/i, /student loans company/i, /\bSLC\b/, /plan [1-5] loan/i, /repayment threshold/i,
  /franchis(ed|ing) (provision|providers?|delivery)/i, /access and participation/i, /\bUCAS\b/i, /teaching grant/i, /bursar(y|ies)/i, /learning entitlement/i
];
const RESIDENCY_TERMS = [/settled status/i, /pre-settled/i, /ordinar(y|ily) residen/i, /residency (requirement|rule)/i, /refugee/i, /humanitarian protection/i,
  /student (finance|support) eligibility/i, /home fee status/i, /irish citizens?/i, /stateless/i, /long residence/i];
const EXCLUDE_TERMS = [/international students?/i, /student visas?/i, /graduate route/i, /\bvisas?\b/i, /immigration skills charge/i, /overseas students?/i,
  /international student levy/i, /sponsor licen[cs]e/i, /\bCAS\b/, /student route/i, /dependants? visa/i];
const SCHOOL_ONLY = [/\bschools?\b/i, /\bacadem(y|ies)\b/i, /\bpupils?\b/i, /early years/i, /\bnurser(y|ies)\b/i, /\bGCSEs?\b/i, /16 to 18/i, /\bSEND\b/,
  /\bOfsted\b/i, /childcare/i, /breakfast club/i, /\bT levels?\b/i, /school food/i, /high needs/i, /teacher (pay|training)/i, /apprenticeship levy/i];
const FE_ONLY = [/residential bursary/i, /residential support scheme/i, /adult education/i, /adult skills/i, /\b16 to 19\b/i, /agricultur/i, /skills bootcamps?/i];
const LOW_VALUE = [/^correction slip$/i, /\bcensus\b/i, /workforce management information/i, /net capacity/i, /\blogin details\b/i, /refund requests/i];

function classify(title, text) {
  const all = title + " \n " + (text || "");
  if (LOW_VALUE.some(r => r.test(title.trim()))) return null;
  if (FE_ONLY.some(r => r.test(title))) return null; // further-education and 16-19 schemes, not HE
  const he = HE_TERMS.filter(r => r.test(all)).length;
  const res = RESIDENCY_TERMS.some(r => r.test(all));
  if (!he && !res) return null;
  // Anything aimed at international or visa students is out, unless it is plainly about home-fee eligibility
  if (EXCLUDE_TERMS.some(r => r.test(all)) && !/home fee|student (finance|support) eligib|eligib\w* for student (finance|support)/i.test(all)) return null;
  // School-only items mention school terms and no strong HE term in the title
  if (SCHOOL_ONLY.some(r => r.test(title)) && !HE_TERMS.some(r => r.test(title))) return null;
  const isLaw = /\b(regulations?|act|bill|order|statutory instrument|legislation)\b/i.test(title);
  const isFunding = /\b(finance|eligib\w*|loans?|grants?|funding|fees?|bursar(y|ies)|allowances?|maintenance|repayment|threshold|support|entitlement)\b/i.test(all);
  const category = isLaw ? "Law" : isFunding ? "Funding" : "Policy";
  const nation = /\(Wales\)|\bWales\b|Cymru/i.test(title) ? "Wales" : /Northern Ireland/i.test(title) ? "Northern Ireland" : /\bScotland\b|\(Scotland\)/i.test(title) ? "Scotland" : "England / UK";
  return { category, nation, score: he + (res ? 2 : 0) + (isLaw ? 1 : 0), residency: res };
}

// ---------- fetching ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function getText(url) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json, application/atom+xml, text/xml;q=0.9, */*;q=0.5" }, signal: AbortSignal.timeout(20000) });
    if (r.ok) return r.text();
    // GOV.UK answers 503/429 when asked too quickly: wait and try again
    if ((r.status === 503 || r.status === 429 || r.status === 502) && attempt < 3) { await sleep(4000 * attempt); continue; }
    const host = new URL(url).hostname, q = new URL(url).searchParams.get("q") || new URL(url).searchParams.get("title") || "";
    throw new Error(`${host}${q ? ` ("${q}")` : ""} answered ${r.status}`);
  }
}
function govukUrl(q) {
  const u = new URL("https://www.gov.uk/api/search.json");
  u.searchParams.set("q", q); u.searchParams.set("order", "-public_timestamp"); u.searchParams.set("count", "40");
  GOVUK_ORGS.forEach(o => u.searchParams.append("filter_organisations[]", o));
  ["title", "description", "link", "public_timestamp", "content_store_document_type", "organisations"].forEach(f => u.searchParams.append("fields[]", f));
  return u.toString();
}
async function fromGovuk(q) {
  const d = JSON.parse(await getText(govukUrl(q)));
  return (d.results || []).filter(r => r.link && !SKIP_DOC_TYPES.has(r.content_store_document_type)).map(r => ({
    title: String(r.title || "").trim(), summary: String(r.description || "").trim(),
    url: r.link.startsWith("http") ? r.link : "https://www.gov.uk" + r.link,
    date: (r.public_timestamp || "").slice(0, 10),
    source: ((r.organisations || [])[0] || {}).title || "GOV.UK",
    kind: String(r.content_store_document_type || "").replace(/_/g, " ")
  }));
}
const decode = (s) => String(s || "").replace(/<p[^>]*xml:lang="cy"[^>]*>[\s\S]*?<\/p>/g, " ").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
async function fromLegislation(url) {
  const xml = await getText(url);
  return [...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/g)].map(m => {
    const e = m[0];
    const pick = (tag) => (e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)) || [])[1];
    const href = (e.match(/<link[^>]*rel="self"[^>]*href="([^"]+)"/) || e.match(/<link[^>]*href="([^"]+)"/) || [])[1] || "";
    const title = decode(pick("title")).replace(/\s+\/\s+(Rheoliadau|Gorchymyn|Deddf)\b.*$/, "");
    return { title, summary: decode(pick("summary")).slice(0, 400), url: href.replace(/^http:/, "https:").replace("/id/", "/"),
      date: (pick("published") || pick("updated") || "").slice(0, 10), source: "legislation.gov.uk", kind: "legislation" };
  }).filter(x => x.title && x.url && !/\/pdfs\//.test(x.url));
}

// ---------- store ----------
function createNews(dataDir) {
  const FILE = path.join(dataDir, "news.json");
  let store = { lastScan: null, lastResult: null, items: {} };
  try { store = Object.assign(store, JSON.parse(fs.readFileSync(FILE, "utf8"))); } catch {}
  let writing = Promise.resolve(), scanning = null;
  const save = () => { const s = JSON.stringify(store, null, 2); writing = writing.then(async () => { await fsp.writeFile(FILE + ".tmp", s); await fsp.rename(FILE + ".tmp", FILE); }); return writing; };
  const idOf = (url) => crypto.createHash("sha1").update(url).digest("hex").slice(0, 16);

  async function scan(reason) {
    if (scanning) return scanning;
    scanning = (async () => {
      const started = new Date().toISOString(), errors = [];
      const jobs = [...GOVUK_QUERIES.map(q => () => fromGovuk(q)), ...LEGISLATION_FEEDS.map(u => () => fromLegislation(u))];
      const found = [];
      for (const job of jobs) { // one at a time, to be polite to the sources
        try { found.push(...await job()); } catch (e) { errors.push(String(e.message || e)); }
        await sleep(1500);
      }
      const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 864e5).toISOString().slice(0, 10);
      let added = 0;
      for (const f of found) {
        if (!f.date || f.date < cutoff) continue;
        const id = idOf(f.url);
        if (store.items[id]) continue;
        const c = classify(f.title, f.summary); if (!c) continue;
        store.items[id] = { id, title: f.title, summary: f.summary, url: f.url, date: f.date, source: f.source, kind: f.kind,
          category: c.category, nation: c.nation, residency: c.residency, score: c.score, status: "pending", foundAt: started };
        added++;
      }
      store.lastScan = started;
      store.lastResult = { reason, checked: found.length, added, errors: errors.slice(0, 5), finishedAt: new Date().toISOString() };
      await save();
      console.log(`[news] scan (${reason}): ${found.length} checked, ${added} new, ${errors.length} source errors`);
      return store.lastResult;
    })().finally(() => { scanning = null; });
    return scanning;
  }

  function ukParts(d) {
    const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
    const o = Object.fromEntries(f.formatToParts(d).map(p => [p.type, p.value]));
    return { day: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) };
  }
  function tick() {
    const now = ukParts(new Date());
    const last = store.lastScan ? ukParts(new Date(store.lastScan)).day : null;
    if (!store.lastScan || (now.hour >= SCAN_HOUR_UK && last !== now.day)) scan(store.lastScan ? "daily" : "first run").catch(e => console.error("[news]", e));
  }
  function start() { setTimeout(tick, 5000); setInterval(tick, 30 * 60e3); }

  function list(admin) {
    const items = Object.values(store.items).filter(i => !i.deleted && (admin || i.status === "approved"))
      .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.score - a.score);
    if (!admin) return { items: items.map(({ id, title, summary, url, date, source, category, nation, residency }) => ({ id, title, summary, url, date, source, category, nation, residency, status: "approved" })) };
    return { lastScan: store.lastScan, lastResult: store.lastResult, scanning: !!scanning, items };
  }
  async function update(id, patch) {
    const it = store.items[id]; if (!it) return null;
    if (["pending", "approved", "hidden"].includes(patch.status)) it.status = patch.status;
    for (const k of ["title", "summary"]) if (typeof patch[k] === "string") it[k] = patch[k].slice(0, k === "title" ? 300 : 1200).trim();
    if (["Law", "Funding", "Policy"].includes(patch.category)) it.category = patch.category;
    it.reviewedAt = new Date().toISOString();
    await save(); return it;
  }
  async function remove(id) { if (!store.items[id]) return false; store.items[id].status = "hidden"; store.items[id].deleted = true; await save(); return true; }

  return { scan, start, list, update, remove, classify };
}

module.exports = { createNews, classify };
