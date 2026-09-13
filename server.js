/*
 * Newsfly — a Drosophila connectome reading the wire.
 *
 * Runs a leaky integrate-and-fire simulation over the real FlyWire FAFB
 * connectome (139,255 neurons), drives it with live news headlines through
 * the sensory populations, and decodes the descending neurons into an
 * editorial verdict. State streams to the browser over Server-Sent Events.
 *
 * Zero dependencies. Node 18+ (needs global fetch).
 *
 * Data:
 *   data/neurons.bin   shipped in the repo (1.9 MB) — positions, nt, class
 *   data/ids.txt.gz    shipped in the repo — root_id per index
 *   data/edges.bin     built on first boot from Codex, then cached
 *
 * Env:
 *   CODEX_TOKEN   FlyWire Codex API token (required on first boot only)
 *   PORT          set by the host
 */

"use strict";

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { Readable } = require("stream");
const { createInterface } = require("readline");

const DATA = path.join(__dirname, "data");
const PUBLIC = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------------ *
 * 1. neurons
 * ------------------------------------------------------------------ */

const NT = ["", "ACH", "GLUT", "GABA", "SER", "DA", "OCT"];
const SUP = ["", "optic", "central", "sensory", "visual_projection", "ascending",
             "descending", "sensory_ascending", "visual_centrifugal", "motor", "endocrine"];

// Fly neurotransmitters: acetylcholine excites; GABA and glutamate (via GluCl)
// inhibit. Modulators are treated as weakly excitatory — they are ~1% of the
// population and a sign for them would be a guess either way.
const NT_SIGN = { "": 1, ACH: 1, GLUT: -1, GABA: -1, SER: 0.3, DA: 0.3, OCT: 0.3 };

let N = 0;
let posX, posY, posZ, ntIdx, supIdx, sideIdx, flowFlags;

function loadNeurons() {
  const buf = fs.readFileSync(path.join(DATA, "neurons.bin"));
  if (buf.slice(0, 4).toString() !== "FLYN") throw new Error("neurons.bin: bad magic");
  N = buf.readUInt32LE(4);
  posX = new Int16Array(N); posY = new Int16Array(N); posZ = new Int16Array(N);
  ntIdx = new Uint8Array(N); supIdx = new Uint8Array(N);
  sideIdx = new Uint8Array(N); flowFlags = new Uint8Array(N);
  const STRIDE = 14;
  for (let i = 0; i < N; i++) {
    const o = 8 + i * STRIDE;
    posX[i] = buf.readInt16LE(o);
    posY[i] = buf.readInt16LE(o + 2);
    posZ[i] = buf.readInt16LE(o + 4);
    ntIdx[i] = buf[o + 6];
    supIdx[i] = buf[o + 7];
    sideIdx[i] = buf[o + 8];
    flowFlags[i] = buf[o + 9];
  }
  console.log(`[neurons] ${N.toLocaleString()} loaded`);
}

function loadIds() {
  const gz = fs.readFileSync(path.join(DATA, "ids.txt.gz"));
  const txt = zlib.gunzipSync(gz).toString("utf8");
  const lines = txt.split("\n");
  const map = new Map();
  for (let i = 0; i < N; i++) {
    const id = lines[i] && lines[i].trim();
    if (id) map.set(id, i);
  }
  console.log(`[ids] ${map.size.toLocaleString()} mapped`);
  return map;
}

/* ------------------------------------------------------------------ *
 * 2. edges — fetched once from Codex, packed to CSR, cached on disk
 * ------------------------------------------------------------------ */

const EDGES_BIN = path.join(DATA, "edges.bin");

// Codex names its download resources by data_product. The download page's
// anchor for "Connections (Filtered)" is #collapseconnections_princeton, so
// that is the first name tried; the rest are fallbacks in case the key moves.
const CODEX_PRODUCTS = [
  "connections_princeton",
  "connections",
  "connections_filtered",
  "connections_no_threshold",
];
function codexUrl(product, token) {
  return "https://codex.flywire.ai/api/download_resource" +
         "?data_product=" + encodeURIComponent(product) +
         "&dataset=fafb&api_token=" + encodeURIComponent(token);
}

let rowPtr, colIdx, colW;   // CSR: rowPtr[i]..rowPtr[i+1] index into colIdx/colW

async function buildEdges(idMap) {
  const token = process.env.CODEX_TOKEN;
  if (!token) {
    throw new Error(
      "edges.bin is missing and CODEX_TOKEN is not set.\n" +
      "Add CODEX_TOKEN in the host's environment settings, then redeploy."
    );
  }
  console.log("[edges] downloading the connection table from Codex…");
  let res = null;
  for (const product of CODEX_PRODUCTS) {
    let r;
    try {
      r = await fetch(codexUrl(product, token));
    } catch (e) {
      console.warn(`[edges] data_product=${product} -> request failed`);
      continue;
    }
    console.log(`[edges] data_product=${product} -> HTTP ${r.status}`);
    if (r.ok) { res = r; break; }
  }
  if (!res) {
    throw new Error(
      "Codex refused every data_product name tried: " + CODEX_PRODUCTS.join(", ") + ".\n" +
      "Open codex.flywire.ai/api/download, expand Connections (Filtered), and send " +
      "the real download link so the name can be corrected."
    );
  }

  const src = Readable.fromWeb(res.body).pipe(zlib.createGunzip());
  const rl = createInterface({ input: src, crlfDelay: Infinity });

  let header = null, iPre = -1, iPost = -1, iSyn = -1, iNt = -1;
  const pre = [], post = [], wt = [];
  let seen = 0, dropped = 0;

  for await (const line of rl) {
    if (!line) continue;
    if (header === null) {
      header = line.split(",").map((s) => s.trim().toLowerCase().replace(/^"|"$/g, ""));
      iPre = header.findIndex((h) => h.includes("pre") && h.includes("root"));
      iPost = header.findIndex((h) => h.includes("post") && h.includes("root"));
      iSyn = header.findIndex((h) => h.includes("syn") && h.includes("count"));
      if (iSyn < 0) iSyn = header.findIndex((h) => h === "weight" || h === "syn_count");
      iNt = header.findIndex((h) => h.includes("nt") && h.includes("type"));
      if (iPre < 0 || iPost < 0) {
        throw new Error("connections: could not find pre/post columns in header: " + header.join(","));
      }
      console.log(`[edges] columns pre=${header[iPre]} post=${header[iPost]} ` +
                  `syn=${iSyn >= 0 ? header[iSyn] : "(none, weight=1)"}`);
      continue;
    }
    const f = line.split(",");
    const a = idMap.get(f[iPre]); const b = idMap.get(f[iPost]);
    seen++;
    if (a === undefined || b === undefined) { dropped++; continue; }
    let w = iSyn >= 0 ? parseInt(f[iSyn], 10) : 1;
    if (!Number.isFinite(w) || w <= 0) w = 1;
    pre.push(a); post.push(b); wt.push(Math.min(w, 32767));
  }
  console.log(`[edges] ${seen.toLocaleString()} rows, ` +
              `${dropped.toLocaleString()} dropped (neuron not in table)`);

  const M = pre.length;
  const counts = new Int32Array(N + 1);
  for (let e = 0; e < M; e++) counts[pre[e] + 1]++;
  for (let i = 0; i < N; i++) counts[i + 1] += counts[i];
  const idxArr = new Int32Array(M);
  const wArr = new Int16Array(M);
  const cursor = Int32Array.from(counts);
  for (let e = 0; e < M; e++) {
    const p = cursor[pre[e]]++;
    idxArr[p] = post[e];
    wArr[p] = wt[e];
  }

  const head = Buffer.alloc(12);
  head.write("FLYE", 0);
  head.writeUInt32LE(N, 4);
  head.writeUInt32LE(M, 8);
  await fsp.writeFile(EDGES_BIN, Buffer.concat([
    head, Buffer.from(counts.buffer), Buffer.from(idxArr.buffer), Buffer.from(wArr.buffer),
  ]));
  console.log(`[edges] packed ${M.toLocaleString()} synaptic connections`);
  rowPtr = counts; colIdx = idxArr; colW = wArr;
}

function loadEdges() {
  const buf = fs.readFileSync(EDGES_BIN);
  if (buf.slice(0, 4).toString() !== "FLYE") throw new Error("edges.bin: bad magic");
  const n = buf.readUInt32LE(4), m = buf.readUInt32LE(8);
  let o = 12;
  rowPtr = new Int32Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + (n + 1) * 4));
  o += (n + 1) * 4;
  colIdx = new Int32Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + m * 4));
  o += m * 4;
  colW = new Int16Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + m * 2));
  console.log(`[edges] ${m.toLocaleString()} connections loaded from cache`);
}

/* ------------------------------------------------------------------ *
 * 2b. tracts — a spread sample of real synaptic connections, as index
 * pairs, so the browser can draw the wiring instead of only the somas.
 * ------------------------------------------------------------------ */

let tractBuf = null;

function buildTracts(maxEdges, perNeuron) {
  const pairs = [];
  for (let i = 0; i < N && pairs.length < maxEdges * 2; i++) {
    const a = rowPtr[i], b = rowPtr[i + 1];
    if (b <= a) continue;
    // strongest few connections out of each neuron, so the sample spreads
    // across the whole brain rather than clumping in the densest hubs
    let best = [];
    for (let e = a; e < b; e++) best.push([colW[e], colIdx[e]]);
    best.sort(function (p, q) { return q[0] - p[0]; });
    const take = Math.min(perNeuron, best.length);
    for (let k = 0; k < take; k++) { pairs.push(i, best[k][1]); }
  }
  const n = pairs.length / 2;
  const buf = Buffer.alloc(8 + n * 8);
  buf.write("FLYT", 0);
  buf.writeUInt32LE(n, 4);
  for (let k = 0; k < n; k++) {
    buf.writeInt32LE(pairs[k * 2], 8 + k * 8);
    buf.writeInt32LE(pairs[k * 2 + 1], 8 + k * 8 + 4);
  }
  tractBuf = buf;
  console.log(`[tracts] ${n.toLocaleString()} connections sampled for the render`);
}

/* ------------------------------------------------------------------ *
 * 3. the simulation
 * ------------------------------------------------------------------ */

const V_THRESH = 1.0;
const LEAK = 0.96;          // per 1 ms step
const REFRACTORY = 2;       // steps
const W_SCALE = 0.0045;     // synapse count -> membrane units

let v, refr, drive, firedNow, spikeCount;
let spikesTotal = 0, brainClockMs = 0;

// Indices of neurons that fired since the last broadcast. The browser lights
// exactly these, so spikes read as individual flashes rather than a smear.
const FLASH_CAP = 1400;
const flash = new Int32Array(FLASH_CAP);
let flashN = 0;

// populations, resolved once from the real classification
let SENSORY = [], DESCENDING = [], OPTIC = [];

function initSim() {
  v = new Float32Array(N);
  refr = new Uint8Array(N);
  drive = new Float32Array(N);
  firedNow = new Uint8Array(N);
  spikeCount = new Uint32Array(N);

  const iSens = SUP.indexOf("sensory"), iSensAsc = SUP.indexOf("sensory_ascending");
  const iDesc = SUP.indexOf("descending"), iOptic = SUP.indexOf("optic");
  for (let i = 0; i < N; i++) {
    const s = supIdx[i];
    if (s === iSens || s === iSensAsc) SENSORY.push(i);
    else if (s === iDesc) DESCENDING.push(i);
    else if (s === iOptic) OPTIC.push(i);
  }
  console.log(`[sim] sensory ${SENSORY.length}, descending ${DESCENDING.length}, optic ${OPTIC.length}`);

  // regions the readout reports on, straight off the real classification
  const iCentral = SUP.indexOf("central"), iVP = SUP.indexOf("visual_projection");
  for (let i = 0; i < N; i++) {
    const s = supIdx[i];
    if (s === iCentral) CENTRAL.push(i);
    else if (s === iVP) VISPROJ.push(i);
    if (sideIdx[i] === 0) LEFT.push(i); else if (sideIdx[i] === 1) RIGHT.push(i);
  }

  // split the descending neurons by side: left reads as WIRE, right as SKIP.
  // arbitrary but fixed, and stated on the page — the fly has no opinion about
  // which hemisphere means what.
  WIRE_POOL = DESCENDING.filter((i) => sideIdx[i] === 0);
  SKIP_POOL = DESCENDING.filter((i) => sideIdx[i] === 1);
  console.log(`[sim] wire pool ${WIRE_POOL.length}, skip pool ${SKIP_POOL.length}`);
}

let WIRE_POOL = [], SKIP_POOL = [], CENTRAL = [], VISPROJ = [], LEFT = [], RIGHT = [];

function step() {
  firedNow.fill(0);
  for (let i = 0; i < N; i++) {
    if (refr[i] > 0) { refr[i]--; v[i] = 0; continue; }
    v[i] = v[i] * LEAK + drive[i];
    if (v[i] >= V_THRESH) {
      firedNow[i] = 1; v[i] = 0; refr[i] = REFRACTORY;
      spikeCount[i]++; spikesTotal++;
      if (flashN < FLASH_CAP) flash[flashN++] = i;
    }
  }
  // propagate only from neurons that actually fired
  for (let i = 0; i < N; i++) {
    if (!firedNow[i]) continue;
    const sign = NT_SIGN[NT[ntIdx[i]]] || 1;
    const a = rowPtr[i], b = rowPtr[i + 1];
    for (let e = a; e < b; e++) {
      v[colIdx[e]] += sign * colW[e] * W_SCALE;
    }
  }
  brainClockMs++;
}

function poolRateHz(pool, windowMs) {
  if (!pool.length || windowMs <= 0) return 0;
  let s = 0;
  for (let k = 0; k < pool.length; k++) s += spikeCount[pool[k]];
  return s / pool.length / (windowMs / 1000);
}

/* ------------------------------------------------------------------ *
 * 4. the wire
 * ------------------------------------------------------------------ */

const FEEDS = [
  { name: "AP World", url: "https://rsshub.app/apnews/topics/world-news" },
  { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "NPR World", url: "https://feeds.npr.org/1004/rss.xml" },
  { name: "Sky News", url: "https://feeds.skynews.com/feeds/rss/world.xml" },
];

// What a wire desk actually weighs. Magnitude first — whether a thing matters
// does not depend on whether somebody happened to film it.
function rx(parts) { return new RegExp("\\b(" + parts.join("|") + ")\\w*", "i"); }

const DEATH = rx(["kill", "dead", "death", "die", "died", "dies", "fatal", "casualt",
                  "massacre", "slain", "executed", "toll", "perish", "bodies"]);
const HARM  = rx(["wound", "injur", "missing", "displac", "evacuat", "strand", "trap",
                  "hostage", "homeless", "starv", "famine", "refugee", "hospitalis",
                  "hospitaliz", "critical condition"]);
const SCALE = rx([
  "war", "invasion", "invade", "coup", "uprising", "revolt", "revolution", "ceasefire",
  "airstrike", "offensive", "occupation", "annex", "genocide", "siege", "bomb",
  "missile", "rocket", "drone", "troop", "militant", "insurgen", "terror",
  "earthquake", "quake", "tsunami", "hurricane", "typhoon", "cyclone", "storm",
  "wildfire", "flood", "landslide", "erupt", "drought", "avalanche", "blizzard",
  "outbreak", "epidemic", "pandemic", "virus", "infect", "spread", "contagio",
  "collapse", "derail", "crash", "explosion", "explode", "blast", "shooting", "shot",
  "attack", "assault", "hijack", "kidnap", "abduct", "raid", "strike",
  "sanction", "impeach", "resign", "oust", "indict", "convict", "verdict", "arrest",
  "election", "referendum", "protest", "riot", "crackdown", "expel", "deport",
  "default", "recession", "bailout", "blackout", "shutdown", "bankrupt", "layoff",
  "inflation", "tariff", "emergency", "crisis", "warning", "alert", "ban", "seize",
]);
const INSTIT = rx([
  "un", "nato", "who", "imf", "opec", "eu", "fed", "central bank", "supreme court",
  "parliament", "congress", "senate", "president", "prime minister", "chancellor",
  "pope", "army", "navy", "military", "police", "government", "minister", "governor",
  "regulator", "court", "authorities", "ministry", "agency",
]);
const VISUAL = rx(["video", "footage", "cctv", "film", "caught on camera", "watch",
                   "dashcam", "images show", "seen on", "captured on", "livestream"]);
const USREL = rx(["u\\.s", "us ", "america", "washington", "trump", "pentagon",
                  "white house", "congress", "new york", "california", "texas",
                  "florida", "chicago", "wall street", "nasdaq", "dollar"]);

function bigNumber(title) {
  if (/\b\d{3,}\b/.test(title)) return 1;
  if (/\b(thousands|millions|hundreds|dozens|scores)\b/i.test(title)) return 0.8;
  const m = title.match(/\b(\d{1,2})\b/);
  return m ? Math.min(0.65, parseInt(m[1], 10) / 30) : 0;
}

function scoreStory(title, ageHours) {
  const death = DEATH.test(title), harm = HARM.test(title);
  const num = bigNumber(title);

  const humanCost = death ? Math.min(1, 0.70 + num * 0.30)
                  : harm  ? Math.min(1, 0.45 + num * 0.35)
                  : num * 0.20;

  let scale = 0;
  if (SCALE.test(title)) scale += 0.62;
  if (INSTIT.test(title)) scale += 0.22;
  if (death) scale += 0.16;
  scale += num * 0.22;

  return [
    VISUAL.test(title) ? 0.92 : 0.20,
    Math.min(1, humanCost),
    Math.min(1, scale),
    USREL.test(title) ? 0.88 : 0.20,
    Math.max(0, 1 - ageHours / 20),
  ];
}

function parseRss(xml, source) {
  const out = [];
  const items = xml.split(/<item[\s>]/i).slice(1);
  for (const raw of items.slice(0, 25)) {
    const t = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(raw);
    const l = /<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i.exec(raw);
    const d = /<pubDate>([\s\S]*?)<\/pubDate>/i.exec(raw);
    if (!t) continue;
    const title = t[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
    if (!title) continue;
    const ts = d ? Date.parse(d[1]) : Date.now();
    out.push({
      id: Buffer.from(title).toString("base64url").slice(0, 22),
      headline: title,
      url: l ? l[1].trim() : "",
      source,
      ts: Number.isFinite(ts) ? ts : Date.now(),
    });
  }
  return out;
}

let queue = [];
const seenIds = new Set();

async function sweep() {
  let added = 0;
  for (const f of FEEDS) {
    try {
      const res = await fetch(f.url, { headers: { "user-agent": "newsfly/1.0" } });
      if (!res.ok) continue;
      const xml = await res.text();
      for (const s of parseRss(xml, f.name)) {
        if (seenIds.has(s.id)) continue;
        seenIds.add(s.id);
        s.ch = scoreStory(s.headline, (Date.now() - s.ts) / 3.6e6);
        queue.push(s);
        added++;
      }
    } catch (e) {
      console.warn(`[wire] ${f.name}: ${e.message}`);
    }
  }
  // freshest first, cap the backlog
  queue.sort((a, b) => b.ts - a.ts);
  if (queue.length > 120) queue.length = 120;
  console.log(`[wire] +${added} stories, ${queue.length} queued`);
}

/* ------------------------------------------------------------------ *
 * 5. the reading loop
 * ------------------------------------------------------------------ */

const READ_MS = 9000;      // simulated ms spent on one headline
const LEDGER_FILE = path.join(DATA, "ledger.json");
let ledger = [];
try { ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8")); } catch (e) { ledger = []; }

let current = null, readStart = 0, lastVerdict = null;

function applyStimulus(story) {
  drive.fill(0);

  // The two output pools are the left and right descending neurons, so the
  // stimulus has to be asymmetric or the hemispheres receive identical input
  // and their rates track each other exactly. Left sensory neurons carry the
  // case FOR running it — footage, casualties, hardware. Right sensory neurons
  // carry the case against: how little there is to show. Everything between
  // the sensory neurons and the descending ones is the real connectome.
  // scale and human cost decide whether it is news; footage only adds to it
  const raw = story.ch[2] * 0.38 + story.ch[1] * 0.32 +
              story.ch[0] * 0.16 + story.ch[3] * 0.14;
  // the raw weights land in roughly 0.05-0.50; stretch that onto 0-1 so the
  // difference between a recipe and a massacre actually reaches the neurons
  const show = Math.max(0, Math.min(1, (raw - 0.05) / 0.45));
  const pass = 1 - show;
  const band = Math.floor(SENSORY.length / 5);

  for (let k = 0; k < SENSORY.length; k++) {
    const i = SENSORY[k];
    const c = Math.min(4, Math.floor(k / band));
    const left = sideIdx[i] === 0;
    const weight = left ? show : pass;
    // channel score still shapes which part of the population carries it
    drive[i] = 0.012 + weight * (0.030 + story.ch[c] * 0.050);
  }

  // a trickle into the optic lobes so the brain isn't silent between stories
  for (let k = 0; k < OPTIC.length; k += 7) drive[OPTIC[k]] = 0.004;
  spikeCount.fill(0);
}

function beginStory() {
  if (!queue.length) return;
  current = queue.shift();
  applyStimulus(current);
  readStart = brainClockMs;
  lastVerdict = null;
  console.log(`[read] ${current.headline.slice(0, 70)}`);
}

function finishStory() {
  const windowMs = brainClockMs - readStart;
  const wireHz = poolRateHz(WIRE_POOL, windowMs);
  const skipHz = poolRateHz(SKIP_POOL, windowMs);
  const verdict = wireHz > skipHz ? "WIRE IT" : "SKIP";
  lastVerdict = verdict;
  const rec = {
    at: new Date().toISOString(),
    headline: current.headline,
    url: current.url,
    source: current.source,
    ch: current.ch,
    wireHz: +wireHz.toFixed(2),
    skipHz: +skipHz.toFixed(2),
    verdict,
  };
  ledger.push(rec);
  if (ledger.length > 500) ledger.shift();
  fsp.writeFile(LEDGER_FILE, JSON.stringify(ledger)).catch(() => {});
  current = null;
}

/* the neurons that fired since the last packet, as 24-bit indices */
function drainFlashes() {
  const n = flashN;
  const b = Buffer.alloc(n * 3);
  for (let k = 0; k < n; k++) {
    const i = flash[k];
    b[k * 3] = i & 255; b[k * 3 + 1] = (i >> 8) & 255; b[k * 3 + 2] = (i >> 16) & 255;
  }
  flashN = 0;
  return b.toString("base64");
}

/* ------------------------------------------------------------------ *
 * 6. http + sse
 * ------------------------------------------------------------------ */

const clients = new Set();

function broadcast() {
  if (!clients.size || bootState.phase !== "running") return;
  const windowMs = Math.max(1, brainClockMs - readStart);
  const R = function (pool) { return +poolRateHz(pool, windowMs).toFixed(2); };
  const payload = JSON.stringify({
    regions: {
      optic: R(OPTIC), central: R(CENTRAL), sensory: R(SENSORY),
      visproj: R(VISPROJ), descending: R(DESCENDING),
      left: R(LEFT), right: R(RIGHT),
    },
    story: current && {
      headline: current.headline, url: current.url, source: current.source, ch: current.ch,
    },
    verdict: lastVerdict,
    wireHz: +poolRateHz(WIRE_POOL, windowMs).toFixed(2),
    skipHz: +poolRateHz(SKIP_POOL, windowMs).toFixed(2),
    spikes: spikesTotal,
    clock: brainClockMs,
    queued: queue.length,
    ticker: queue.slice(0, 8).map(function (q) { return q.headline; }),
    fired: drainFlashes(),
  });
  for (const res of clients) {
    try { res.write(`data: ${payload}\n\n`); } catch (e) { clients.delete(res); }
  }
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript",
               ".css": "text/css", ".bin": "application/octet-stream",
               ".json": "application/json", ".png": "image/png",
               ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
               ".svg": "image/svg+xml", ".ico": "image/x-icon",
               ".mp4": "video/mp4", ".woff2": "font/woff2" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": open\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (url.pathname === "/api/ledger") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(ledger.slice(-100).reverse()));
  }

  if (url.pathname === "/api/status") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(bootState));
  }

  if (url.pathname === "/api/meta") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({
      neurons: N,
      edges: colIdx ? colIdx.length : 0,
      dataset: "FlyWire FAFB v783 (CC-BY 4.0)",
      sensory: SENSORY.length, descending: DESCENDING.length,
      wirePool: WIRE_POOL.length, skipPool: SKIP_POOL.length,
    }));
  }

  if (url.pathname === "/data/tracts.bin") {
    if (!tractBuf) { res.writeHead(503); return res.end("not ready"); }
    res.writeHead(200, { "content-type": "application/octet-stream",
                         "cache-control": "public, max-age=86400" });
    return res.end(tractBuf);
  }

  if (url.pathname === "/data/neurons.bin") {
    res.writeHead(200, { "content-type": "application/octet-stream",
                         "cache-control": "public, max-age=86400" });
    return fs.createReadStream(path.join(DATA, "neurons.bin")).pipe(res);
  }

  const file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(full)] || "text/plain" });
    res.end(data);
  });
});

/* ------------------------------------------------------------------ *
 * 7. boot
 * ------------------------------------------------------------------ */

let bootState = { phase: "starting", error: null, neurons: 0, edges: 0 };

process.on("uncaughtException", function (e) {
  console.error("[fatal] uncaught:", e && e.stack || e);
  bootState = { phase: "failed", error: String(e && e.message || e) };
});
process.on("unhandledRejection", function (e) {
  console.error("[fatal] unhandled rejection:", e && e.stack || e);
  bootState = { phase: "failed", error: String(e && e.message || e) };
});

// Bind the port first. If loading the connectome fails, the page still serves
// and says why, instead of the process dying before it prints anything.
server.listen(PORT, function () {
  console.log(`[http] listening on ${PORT}`);
  boot().catch(function (e) {
    console.error("\n[boot] " + (e && e.stack || e) + "\n");
    bootState = { phase: "failed", error: String(e && e.message || e) };
  });
});

async function boot() {
  bootState.phase = "neurons";
  loadNeurons();
  bootState.neurons = N;

  if (fs.existsSync(EDGES_BIN)) {
    bootState.phase = "edges-cache";
    loadEdges();
  } else {
    bootState.phase = "edges-download";
    await buildEdges(loadIds());
  }
  bootState.edges = colIdx ? colIdx.length : 0;

  bootState.phase = "wiring";
  initSim();
  buildTracts(52000, 1);

  bootState.phase = "wire";
  await sweep().catch(function (e) { console.warn("[wire] " + e.message); });
  setInterval(function () { sweep().catch(function () {}); }, 10 * 60 * 1000);

  setInterval(function () {
    if (!current) beginStory();
    for (let st = 0; st < 400; st++) step();
    if (current && brainClockMs - readStart >= READ_MS) finishStory();
  }, 100);

  setInterval(broadcast, 250);
  bootState.phase = "running";
  console.log("[boot] running");
}
