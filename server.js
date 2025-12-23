// server.js
"use strict";
const fsExtra = require('fs-extra'); // for safe file deletion
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const dotenv = require("dotenv");
const multer = require('multer'); 
const axios = require("axios");
const crypto = require("crypto");


// Path to the doginals CLI script
const DOGINALS_SCRIPT = path.join(__dirname, 'scripts', 'doginals.js');

// Doginals-related directories
const DOGINALS_IMAGES_DIR = path.join(__dirname, 'images');
const DOGINALS_JSON_DIR = path.join(__dirname, 'json');
const DOGINALS_WALLETS_DIR = path.join(__dirname, 'wallets');
const UPLOADS_DIR = path.join(__dirname, "uploads");
const SAVES_DIR = path.join(__dirname, "saves");


for (const dir of [UPLOADS_DIR, SAVES_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Ensure dirs exist
for (const dir of [DOGINALS_IMAGES_DIR, DOGINALS_JSON_DIR, DOGINALS_WALLETS_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
dotenv.config();

const {
  ensureInscriptionDecoded,
  handleHtmlSvgDependencies,
  getProgress,
  CONTENT_DIR,
  MASTER_PATH,
  findContentFile,
} = require("./scripts/decode");

const app = express();
const PORT = process.env.PORT || 3000;
const ENV_PATH = path.join(__dirname, '.env');


app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const ROOT = __dirname;

app.use("/assets", express.static(path.join(__dirname, "assets")));
app.use("/images", express.static(DOGINALS_IMAGES_DIR));

app.get("/content/:id", (req, res, next) => {
  const raw = req.params.id || "";
  if (raw.includes(".")) return next();

  const filePath = findContentFile(raw);
  if (!filePath) {
    return res.status(404).send("Content not found");
  }

  res.sendFile(filePath);
});

app.use(
  "/content",
  express.static(CONTENT_DIR, {
    setHeaders: (res) => {
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    },
  })
);

app.use("/assets-page", express.static(path.join(__dirname, "assets-page")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "assets-page", "info.html"));
});

app.get("/explore", (req, res) => {
  res.sendFile(path.join(__dirname, "assets-page", "explore.html"));
});

app.get("/viewer", (req, res) => {
  res.sendFile(path.join(__dirname, "assets-page", "index.html"));
});

app.get("/explore.html", (req, res) => {
  res.sendFile(path.join(__dirname, "assets-page", "explore.html"));
});

app.get('/assets-page/dev-cli.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'assets-page', 'dev-cli.html'));
});

// Node status page (Dogecoin)
app.get('/assets-page/node-status.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'assets-page', 'node-status.html'));
});

// Metadata Forge page
app.get("/metadata", (req, res) => {
  res.sendFile(path.join(__dirname, "assets-page", "metadata.html"));
});

app.get("/metadata.html", (req, res) => {
  res.sendFile(path.join(__dirname, "assets-page", "metadata.html"));
});

// define.html (explicit route)
app.get("/define", (req, res) => {
  res.sendFile(path.join(__dirname, "assets-page", "define.html"));
});

// optionally also allow direct /define.html
app.get("/define.html", (req, res) => {
  res.sendFile(path.join(__dirname, "assets-page", "define.html"));
});

// ---------- AIRDROP (SINGLE WALLET) HELPERS ----------

function getAirdropStatePath(label) {
  const dir = getDoginalsWalletDir(label);
  return path.join(dir, "airdrop-state.json");
}

function loadAirdropState(label) {
  const p = getAirdropStatePath(label);
  if (!fs.existsSync(p)) {
    return {
      label,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),

      // optional: you can set these from UI later
      tokenMasterUtxo: null, // "txid:vout"

      // computed each scan: biggest confirmed utxo >= 1 DOGE
      feeUtxo: null, // { txid, vout, satoshis, doge, confirmations }

      // last seen wallet snapshot
      lastUtxoKeys: [],

      // queue of transfers to send out
      // items: { id, inscriptionId, toAddress, status, createdAt, updatedAt, txid?, error? }
      queue: [],

      // record of what we observed
      observed: {
        newUtxos: [],
        removedUtxos: [],
        lastScanAt: null,
      },
    };
  }

  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (_) {
    // if corrupted, start fresh but don't crash server
    return {
      label,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tokenMasterUtxo: null,
      feeUtxo: null,
      lastUtxoKeys: [],
      queue: [],
      observed: { newUtxos: [], removedUtxos: [], lastScanAt: null },
    };
  }
}

function saveAirdropState(label, state) {
  const p = getAirdropStatePath(label);
  state.updatedAt = new Date().toISOString();
  atomicWriteJson(p, state);
  return state;
}

function utxoKey(txid, vout) {
  return `${txid}:${vout}`;
}

function normalizeWalletUtxos(wallet) {
  // returns array of { txid, vout, satoshis, confirmations?, key }
  const out = [];
  if (!wallet || !Array.isArray(wallet.utxos)) return out;

  const seen = new Set();
  for (const u of wallet.utxos) {
    if (!u || !u.txid || typeof u.vout === "undefined") continue;
    const key = utxoKey(u.txid, u.vout);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      txid: u.txid,
      vout: u.vout,
      satoshis: Number(u.satoshis || 0),
      confirmations: Number(u.confirmations || 0), // doginals wallet.json may not have this; we handle later
      key,
    });
  }
  return out;
}

async function attachConfirmationsViaNode(utxos) {
  // listunspent gives confirmations + amount; we map it back to txid:vout
  try {
    const unspent = await callDogecoinRpc("listunspent", [0, 9999999, []]);
    const map = new Map();
    for (const u of unspent || []) {
      map.set(utxoKey(u.txid, u.vout), {
        confirmations: Number(u.confirmations || 0),
        amount: Number(u.amount || 0),
      });
    }

    return utxos.map((x) => {
      const info = map.get(x.key);
      const confirmations = info ? info.confirmations : (Number.isFinite(x.confirmations) ? x.confirmations : 0);
      const doge = Number.isFinite(x.satoshis) ? x.satoshis / 1e8 : (info ? info.amount : 0);
      return { ...x, confirmations, doge };
    });
  } catch (_) {
    // if node RPC fails, just return as-is (testing mode)
    return utxos.map((x) => ({ ...x, doge: x.satoshis / 1e8 }));
  }
}

function pickFeeUtxo(utxosWithConf, minDoge = 1) {
  // biggest confirmed utxo >= minDoge
  const eligible = (utxosWithConf || []).filter(
    (u) => Number(u.doge || 0) >= minDoge && Number(u.confirmations || 0) > 0
  );
  if (!eligible.length) return null;

  eligible.sort((a, b) => (b.satoshis || 0) - (a.satoshis || 0));
  const top = eligible[0];

  return {
    txid: top.txid,
    vout: top.vout,
    satoshis: top.satoshis,
    doge: Number(top.doge || 0),
    confirmations: Number(top.confirmations || 0),
    key: top.key,
  };
}

function makeId() {
  return crypto.randomBytes(12).toString("hex");
}


// ---------- DOGINALS / WALLET HELPERS ----------

// wallet dir + .wallet.json resolving
function getDoginalsWalletDir(label) {
  const safe = (label || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'wallet1';
  const dir = path.join(DOGINALS_WALLETS_DIR, safe);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getDoginalsWalletPath(label) {
  return path.join(getDoginalsWalletDir(label), '.wallet.json');
}

function readDoginalsWallet(label) {
  const p = getDoginalsWalletPath(label);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function runDoginals(args, { walletLabel, onStdoutChunk, onStderrChunk } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (walletLabel) {
      env.WALLET = getDoginalsWalletPath(walletLabel);
    }

    const child = spawn(process.execPath, [DOGINALS_SCRIPT, ...args], {
      cwd: path.join(__dirname, 'scripts'),
      env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (onStdoutChunk) {
        onStdoutChunk(s);
      }
    });

    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onStderrChunk) {
        onStderrChunk(s);
      }
    });

    child.on('error', (err) => reject(err));

    child.on('close', (code) => {
      if (code !== 0) {
        const err = new Error(`doginals exited with code ${code}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Write a single SSE line to the response.
 */
function sseWrite(res, line) {
  try {
    res.write(`data: ${line}\n\n`);
  } catch (_) {
    // ignore broken pipe etc.
  }
}
/**
 * Send a named SSE event with JSON payload
 */
function sseEvent(res, event, payload) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload || {})}\n\n`);
  } catch (_) {
    // ignore broken pipe etc.
  }
}



// fee helper (FEE_PER_KB from .env)
function getFeePerKb() {
  const raw = process.env.FEE_PER_KB;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : 100000000; // default 1 DOGE/kB in sats
}

// simple wallet log helper (per wallet)
function appendWalletLog(label, text) {
  try {
    const dir = getDoginalsWalletDir(label);
    const logPath = path.join(dir, 'doginals.log');
    const line = `[${new Date().toISOString()}]\n${text}\n\n`;
    fs.appendFileSync(logPath, line);
  } catch (err) {
    console.error('appendWalletLog error', err);
  }
}

// ---------- LOG PARSING HELPERS (server-side index + drilldown) ----------

function safeBasename(name) {
  const base = path.basename(String(name || ""));
  if (!base || base.includes("..") || base.includes("/") || base.includes("\\")) return null;
  return base;
}

function parseDoginalsLogText(logText) {
  const text = String(logText || "");
  const lines = text.split(/\r?\n/);

  const entries = [];
  let current = null;

  const tsRe = /^\[(\d{4}-\d{2}-\d{2}T[^]+\.\d{3}Z)\]\s*$/;

  const flush = () => {
    if (!current) return;

    // title = first non-empty line after timestamp
    let title = "";
    for (const l of current.lines) {
      const t = String(l || "").trim();
      if (t) { title = t; break; }
    }

    // detect outputJson
    let outputJson = null;
    for (const l of current.lines) {
      const m = String(l || "").match(/outputJson=([^\s]+)/);
      if (m && m[1]) { outputJson = m[1].trim(); break; }
    }

    // classify type (optional, but useful for UI)
    const upper = title.toUpperCase();
    let type = "other";
    if (upper.startsWith("DRC20 MINT")) type = "drc20-mint";
    else if (upper.startsWith("DRC20 DEPLOY")) type = "drc20-deploy";
    else if (upper.startsWith("CREATED WALLET")) type = "wallet-created";
    else if (upper.startsWith("WALLET SPLIT")) type = "wallet-split";
    else if (upper.startsWith("DOGINALS FILE MINT")) type = "doginals-file-mint";

    const rawBlock = `[${current.ts}]\n` + current.lines.join("\n").trimEnd() + "\n";

    // stable-ish id based on timestamp + title + raw block hash
    const id = crypto
      .createHash("sha1")
      .update(String(current.ts) + "\n" + String(title) + "\n" + rawBlock)
      .digest("hex");

    entries.push({
      id,
      timestamp: current.ts,
      title: title || "(no title)",
      type,
      hasJson: !!outputJson,
      jsonFile: outputJson || null,
      rawBlock,
    });

    current = null;
  };

  for (const line of lines) {
    const m = line.match(tsRe);
    if (m) {
      // new entry begins
      flush();
      current = { ts: m[1], lines: [] };
      continue;
    }
    if (!current) {
      // ignore preamble text if any
      continue;
    }
    current.lines.push(line);
  }

  flush();

  // newest first (ISO timestamps sort lexicographically)
  entries.sort((a, b) => (a.timestamp > b.timestamp ? -1 : a.timestamp < b.timestamp ? 1 : 0));
  return entries;
}

function readWalletLogText(label) {
  const dir = getDoginalsWalletDir(label);
  const logPath = path.join(dir, "doginals.log");
  if (!fs.existsSync(logPath)) return "";
  try {
    return fs.readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}

function getWalletLogEntries(label) {
  const txt = readWalletLogText(label);
  return parseDoginalsLogText(txt);
}


// multer storage for doginals file uploads
const doginalsStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, DOGINALS_IMAGES_DIR);
  },
  filename: (req, file, cb) => {
    // keep original name so ordering via naming scheme works
    cb(null, file.originalname);
  },
});

const doginalsUpload = multer({ storage: doginalsStorage });

// -------------------------------------------
// GENESIS TXID FINDER (PORTED FROM PY LOGIC)
// -------------------------------------------

async function rpcCall(method, params) {
  const body = {
      jsonrpc: "1.0",
      id: "doginals-genesis",
      method,
      params
  };

  const auth = {
      username: process.env.NODE_RPC_USER,
      password: process.env.NODE_RPC_PASS || ""
  };

  const res = await axios.post(process.env.NODE_RPC_URL, body, { auth });
  if (res.data.error) throw new Error(res.data.error.message);
  return res.data.result;
}

async function findGenesisTxid(startTxid) {
  let current = startTxid;
  const visited = new Set();

  while (true) {
      if (visited.has(current)) throw new Error("Cycle detected");
      visited.add(current);

      const tx = await rpcCall("getrawtransaction", [current, true]);
      const vin = tx.vin || [];
      const vout = tx.vout || [];
      const isCoinbase = vin.some(v => v.coinbase);

      // Genesis condition
      if (vin.length === 1 && vout.length === 2 && !isCoinbase) {
          return current;
      }

      if (!vin.length || isCoinbase) {
          throw new Error("Chain ended without finding genesis");
      }

      // Follow smallest input
      let smallest = Infinity;
      let nextTx = null;

      for (const input of vin) {
          if (!input.txid) continue;
          const prevTx = await rpcCall("getrawtransaction", [input.txid, true]);
          const amount = prevTx.vout[input.vout].value;
          if (amount < smallest) {
              smallest = amount;
              nextTx = input.txid;
          }
      }

      if (!nextTx) throw new Error("No valid previous tx found");

      current = nextTx;
  }
}

function loadMasterSafe() {
  try {
    if (!fs.existsSync(MASTER_PATH)) return {};
    const raw = fs.readFileSync(MASTER_PATH, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (e) {
    console.warn("Failed to read master.json:", e.message);
    return {};
  }
}

function normalizeBaseTxid(idOrTxid) {
  const clean = String(idOrTxid || "").trim();
  return clean.replace(/i\d+$/i, "");
}

app.get("/api/inscription/:id", async (req, res) => {
  const rawId = decodeURIComponent(req.params.id || "");
  const baseTxid = normalizeBaseTxid(rawId);
  const progressKey = baseTxid;

  if (!baseTxid || baseTxid.length < 10) {
    return res.status(400).json({ error: "Invalid txid/inscription id" });
  }

  try {
    const result = await ensureInscriptionDecoded(rawId, { progressKey });

    const master = loadMasterSafe();
    const entry = master[result.inscriptionId] || {};
    const filename =
      entry.filename ||
      `${result.inscriptionId}.${(result.mimeType || "bin").split("/")[1] || "bin"}`;
    const filePath = path.join(CONTENT_DIR, filename);

    let size = entry.size;
    if (!size && fs.existsSync(filePath)) {
      size = fs.statSync(filePath).size;
    }

    const mt = (result.mimeType || "").toLowerCase();
    if (mt.includes("html") || mt.includes("svg")) {
      await handleHtmlSvgDependencies(
        result.inscriptionId,
        result.mimeType,
        result.resultBuf,
        undefined,
        { progressKey }
      );
    }

    return res.json({
      url: `/content/${filename}`,
      txid: normalizeBaseTxid(result.inscriptionId),
      inscriptionId: result.inscriptionId,
      filename,
      mimeType: result.mimeType,
      size: size || 0,
      fromCache: !!result.fromCache,
    });
  } catch (err) {
    console.error("Error in /api/inscription:", err);
    const msg = err && err.message ? err.message : "Unknown error";
    return res.status(500).json({ error: msg });
  }
});

const RAWDATA_DIR = path.join(CONTENT_DIR, "rawdata");
const INSPECT_SCRIPT = path.join(ROOT, "scripts", "inspect.js");

function ensureRawdataDir() {
  if (!fs.existsSync(RAWDATA_DIR)) {
    fs.mkdirSync(RAWDATA_DIR, { recursive: true });
  }
}



app.get("/api/inspect/:id", async (req, res) => {
  const rawId = decodeURIComponent(req.params.id || "");
  const baseTxid = normalizeBaseTxid(rawId);

  if (!baseTxid || baseTxid.length < 10) {
    return res.status(400).json({ error: "Invalid txid/inscription id" });
  }

  ensureRawdataDir();
  const cachePath = path.join(RAWDATA_DIR, `${baseTxid}.txt`);

  if (fs.existsSync(cachePath)) {
    try {
      const text = fs.readFileSync(cachePath, "utf8");
      return res.json({ rawText: text, fromCache: true });
    } catch (e) {
      console.warn("Failed to read cached inspect data:", e.message);
    }
  }

  if (!fs.existsSync(INSPECT_SCRIPT)) {
    const stub = `inspect.js not found.\nBase TXID: ${baseTxid}\nYou can implement scripts/inspect.js to provide richer info.`;
    return res.json({ rawText: stub, fromCache: false });
  }

  try {
    const child = spawn("node", [INSPECT_SCRIPT, baseTxid], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        try {
          fs.writeFileSync(cachePath, stdout, "utf8");
        } catch (e) {
          console.warn("Failed to write inspect cache:", e.message);
        }
        return res.json({ rawText: stdout || "(no output)", fromCache: false });
      } else {
        const msg = stderr || stdout || `inspect.js exited with code ${code}`;
        return res.status(500).json({ error: msg, rawText: msg });
      }
    });
  } catch (e) {
    console.error("Error spawning inspect.js:", e);
    return res
      .status(500)
      .json({ error: "Failed to run inspect.js", rawText: String(e) });
  }
});

app.get("/api/progress/:id", (req, res) => {
  const rawId = decodeURIComponent(req.params.id || "");
  const baseTxid = normalizeBaseTxid(rawId);
  const key = baseTxid;

  if (!key || key.length < 10) {
    res.writeHead(400, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(
      `data: ${JSON.stringify({ error: "Invalid txid", active: false })}\n\n`
    );
    return res.end();
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  res.flushHeaders?.();

  let interval;

  const sendSnapshot = () => {
    const snap = getProgress(key);

    if (!snap) {
      const payload = {
        txid: key,
        waiting: true,
        active: false,
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      return;
    }

    const payload = {
      txid: snap.txid,
      label: snap.label,
      chunksFound: snap.chunksFound,
      estimatedTotal: snap.estimatedTotal,
      remaining: snap.remaining,
      active: snap.active,
      startedAt: snap.startedAt,
      updatedAt: snap.updatedAt,
      depTotal: snap.depTotal,
      depDone: snap.depDone,
      depRemaining: snap.depRemaining,
    };

    res.write(`data: ${JSON.stringify(payload)}\n\n`);

    if (!snap.active) {
      if (interval) clearInterval(interval);
      res.end();
    }
  };

  sendSnapshot();
  interval = setInterval(sendSnapshot, 500);

  req.on("close", () => {
    if (interval) clearInterval(interval);
  });
});

app.get("/api/doginals/list", (req, res) => {
  try {
    const master = loadMasterSafe();
    const entries = [];

    for (const [inscriptionId, meta] of Object.entries(master)) {
      if (!meta) continue;

      let filename = meta.filename || null;
      let filePath = null;

      if (filename) {
        filePath = path.join(CONTENT_DIR, filename);
        if (!fs.existsSync(filePath)) {
          filePath = null;
        }
      }

      if (!filePath) {
        filePath = findContentFile(inscriptionId);
        if (!filePath || !fs.existsSync(filePath)) continue;
        filename = path.basename(filePath);
      }

      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }

      const ext = path.extname(filename).slice(1).toLowerCase();
      const mimeType =
        meta.mimeType || meta.contentType || "application/octet-stream";
      const txid = meta.txid || normalizeBaseTxid(inscriptionId);

      entries.push({
        inscriptionId,
        txid,
        filename,
        url: "/content/" + filename,
        mimeType,
        contentType: mimeType,
        size: stat.size,
        ext,
        createdAt: meta.createdAt || null,
      });
    }

    entries.sort((a, b) => {
      if (a.createdAt && b.createdAt) {
        if (a.createdAt > b.createdAt) return -1;
        if (a.createdAt < b.createdAt) return 1;
      }
      if (a.txid > b.txid) return -1;
      if (a.txid < b.txid) return 1;
      return 0;
    });

    res.json(entries);
  } catch (err) {
    console.error("Error in /api/doginals/list:", err);
    res
      .status(500)
      .json({ error: err.message || "Failed to list inscriptions." });
  }
});

app.get('/api/doginals/wallets', async (req, res) => {
  try {
    if (!fs.existsSync(DOGINALS_WALLETS_DIR)) {
      fs.mkdirSync(DOGINALS_WALLETS_DIR, { recursive: true });
    }

    const dirs = fs
      .readdirSync(DOGINALS_WALLETS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory());

      const wallets = [];

      for (const d of dirs) {
        const label = d.name;
  
        // 1) always sync wallet against the node on each load
        try {
          await runDoginals(['wallet', 'sync'], { walletLabel: label });
        } catch (e) {
          console.warn('wallet sync failed for', label, e.message);
        }
  
        // 2) read the .wallet.json that doginals actually uses
        const w = readDoginalsWallet(label);
  
        let balance = null;
        let utxoCount = 0;  // NEW: track distinct UTXOs
  
        if (w && Array.isArray(w.utxos) && w.utxos.length) {
          const seen = new Set();
          let totalSats = 0;
  
          for (const u of w.utxos) {
            if (!u || !u.txid) continue;
            const key = `${u.txid}:${u.vout}`;
            if (seen.has(key)) continue;        // de-dupe any duplicates
            seen.add(key);
  
            const s = Number(u.satoshis || 0);
            if (Number.isFinite(s)) totalSats += s;
          }
  
          balance = totalSats / 1e8;            // convert to DOGE
          utxoCount = seen.size;                // NEW: unique UTXO count
        }
  
        wallets.push({
          label,
          address: (w && w.address) || null,
          hasWallet: !!w,
          balance,
          unconfirmed: null, // we don't track this per wallet.json right now
          utxoCount,         // NEW: expose to frontend
        });
      }
  
      res.json({ wallets });
  
  } catch (err) {
    console.error('Error in /api/doginals/wallets:', err);
    res
      .status(500)
      .json({ error: 'Failed to list wallets', message: err.message });
  }
});


// GET /api/doginals/wallets/:label/log
app.get('/api/doginals/wallets/:label/log', (req, res) => {
  try {
    const label = (req.params.label || '').trim();
    if (!label) return res.status(400).json({ error: 'label required' });

    const dir = getDoginalsWalletDir(label);
    const logPath = path.join(dir, 'doginals.log');
    if (!fs.existsSync(logPath)) {
      return res.json({ ok: true, label, log: '' });
    }
    const content = fs.readFileSync(logPath, 'utf8');
    res.json({ ok: true, label, log: content });
  } catch (err) {
    console.error('Error in /api/doginals/wallets/:label/log:', err);
    res.status(500).json({ error: 'Failed to read log', message: err.message });
  }
});

// GET /api/doginals/wallets/:label/log/index
// Returns shortlist entries: timestamp + title + (optional) jsonFile
app.get("/api/doginals/wallets/:label/log/index", (req, res) => {
  try {
    const label = (req.params.label || "").trim();
    if (!label) return res.status(400).json({ ok: false, error: "label required" });

    const entries = getWalletLogEntries(label).map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      title: e.title,
      type: e.type,
      hasJson: e.hasJson,
      jsonFile: e.jsonFile,
    }));

    res.json({ ok: true, label, entries });
  } catch (err) {
    console.error("Error in /api/doginals/wallets/:label/log/index:", err);
    res.status(500).json({ ok: false, error: "Failed to parse log", message: err.message });
  }
});

// GET /api/doginals/wallets/:label/log/entry/:id
// Returns raw log block ALWAYS, and if outputJson exists, appends JSON content for UI.
app.get("/api/doginals/wallets/:label/log/entry/:id", (req, res) => {
  try {
    const label = (req.params.label || "").trim();
    const id = (req.params.id || "").trim();
    if (!label) return res.status(400).json({ ok: false, error: "label required" });
    if (!id) return res.status(400).json({ ok: false, error: "id required" });

    const entries = getWalletLogEntries(label);
    const entry = entries.find((e) => e.id === id);
    if (!entry) return res.status(404).json({ ok: false, error: "Entry not found" });

    // Always return the raw block (top of viewer)
    const basePayload = {
      ok: true,
      label,
      id,
      timestamp: entry.timestamp,
      title: entry.title,
      type: entry.type,
      text: entry.rawBlock,
    };

    // If there's no referenced json, just return the log
    if (!entry.hasJson || !entry.jsonFile) {
      return res.json({
        ...basePayload,
        kind: "text",
      });
    }

    const base = safeBasename(entry.jsonFile);
    if (!base) {
      return res.json({
        ...basePayload,
        kind: "text",
        json: null,
        jsonFile: null,
        jsonError: "Invalid jsonFile in log entry",
      });
    }

    const full = path.join(DOGINALS_JSON_DIR, base);
    if (!fs.existsSync(full)) {
      return res.json({
        ...basePayload,
        kind: "text+json",
        jsonFile: base,
        json: null,
        jsonText: `{\n  "error": "Referenced JSON file not found",\n  "jsonFile": "${base}"\n}\n`,
      });
    }

    try {
      const data = JSON.parse(fs.readFileSync(full, "utf8"));
      const pretty = JSON.stringify(data, null, 2);

      return res.json({
        ...basePayload,
        kind: "text+json",
        jsonFile: base,
        json: data,       // if your UI wants structured
        jsonText: pretty, // if your UI wants to just append text
      });
    } catch (e) {
      return res.json({
        ...basePayload,
        kind: "text+json",
        jsonFile: base,
        json: null,
        jsonText: `{\n  "error": "Failed to read/parse referenced JSON",\n  "message": ${JSON.stringify(
          e.message || String(e)
        )},\n  "jsonFile": "${base}"\n}\n`,
      });
    }
  } catch (err) {
    console.error("Error in /api/doginals/wallets/:label/log/entry/:id:", err);
    res.status(500).json({ ok: false, error: "Failed to load entry", message: err.message });
  }
});



// GET /api/doginals/json/:file
app.get('/api/doginals/json/:file', (req, res) => {
  try {
    const file = (req.params.file || '').trim();
    if (!file || file.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const full = path.join(DOGINALS_JSON_DIR, file);
    if (!fs.existsSync(full)) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.sendFile(full);
  } catch (err) {
    console.error('Error in /api/doginals/json/:file:', err);
    res.status(500).json({ error: 'Failed to load JSON', message: err.message });
  }
});


const http = require("http");
const https = require("https");

// Raw env values
const NODE_RPC_URL  = process.env.NODE_RPC_URL  || "http://127.0.0.1:22555";
const NODE_RPC_USER = process.env.NODE_RPC_USER || "";
const NODE_RPC_PASS = process.env.NODE_RPC_PASS || "";

// Parse URL to get host/port/protocol, and optional user:pass if present
const rpcUrl = new URL(NODE_RPC_URL);

const DOGE_RPC_HOST = rpcUrl.hostname;
const DOGE_RPC_PORT = parseInt(
  rpcUrl.port || (rpcUrl.protocol === "https:" ? 443 : 80),
  10
);

// Final credentials: env values win, fallback to URL-embedded creds if any
const DOGE_RPC_USER = NODE_RPC_USER || rpcUrl.username || "";
const DOGE_RPC_PASSWORD = NODE_RPC_PASS || rpcUrl.password || "";

// Choose http vs https module based on URL
const rpcHttp = rpcUrl.protocol === "https:" ? https : http;

/**
 * Try to interpret a string as number / boolean / JSON / or leave as string.
 * This lets you type 1, true, ["addr1","addr2"] in the UI and they become
 * real JSON params for the RPC call.
 */
function smartParseArg(raw) {
  if (typeof raw !== "string") return raw;
  const v = raw.trim();
  if (v === "") return "";

  if (v === "true") return true;
  if (v === "false") return false;

  if (!Number.isNaN(Number(v)) && v !== "") {
    return Number(v);
  }

  // Attempt JSON for { ... } or [ ... ]
  if (
    (v.startsWith("{") && v.endsWith("}")) ||
    (v.startsWith("[") && v.endsWith("]"))
  ) {
    try {
      return JSON.parse(v);
    } catch {
      // fall through to string
    }
  }

  return v;
}

/**
 * Low-level JSON-RPC call to dogecoind using NODE_RPC_* config.
 */
function callDogecoinRpc(method, params = []) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: "1.0",
      id: "dev-cli",
      method,
      params,
    });

    const options = {
      hostname: DOGE_RPC_HOST,
      port: DOGE_RPC_PORT,
      path: "/",
      method: "POST",
      auth: `${DOGE_RPC_USER}:${DOGE_RPC_PASSWORD}`,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = rpcHttp.request(options, (resp) => {
      let data = "";

      resp.on("data", (chunk) => {
        data += chunk.toString("utf8");
      });

      resp.on("end", () => {
        try {
          const json = JSON.parse(data);

          if (json.error) {
            const err = new Error(json.error.message || "RPC error");
            err.code = json.error.code;
            err.data = json.error;
            return reject(err);
          }

          resolve(json.result);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

async function waitForTxConfirmation(txid, sendLog) {
  const intervalMs = 30000; // 30s
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const tx = await callDogecoinRpc('gettransaction', [txid, true]);
      const conf = Number(tx && tx.confirmations ? tx.confirmations : 0);

      if (conf > 0) {
        if (sendLog) {
          sendLog(
            `[server] tx ${txid} confirmed with ${conf} confirmation(s).`
          );
        }
        return;
      }

      if (sendLog) {
        sendLog(
          `[server] tx ${txid} still unconfirmed; waiting ${
            intervalMs / 1000
          }s...`
        );
      }
    } catch (e) {
      if (sendLog) {
        sendLog(
          `[server] error checking tx ${txid}: ${e.message || String(e)}`
        );
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}


// Only allow the commands exposed in dev-cli.html
const ALLOWED_DEV_COMMANDS = new Set([
  "getblockchaininfo",
  "getnetworkinfo",
  "getconnectioncount",
  "getbestblockhash",
  "validateaddress",
  "dumpprivkey",
  "getbalance",
  "listunspent",
  "gettransaction",
  "getrawtransaction",
  "decoderawtransaction",
  "getblockhash",
  "getblock",
  "createrawtransaction",
]);

// Dev CLI: proxy allowed commands to dogecoind RPC
app.post("/api/dev/cli/run", async (req, res) => {
  const { command, args } = req.body || {};

  if (!command || !ALLOWED_DEV_COMMANDS.has(command)) {
    return res.status(400).json({ error: "Command not allowed" });
  }

  const params = Array.isArray(args)
    ? args
        .filter((v) => v !== "" && v !== null && v !== undefined)
        .map((v) => smartParseArg(String(v)))
    : [];

  try {
    const result = await callDogecoinRpc(command, params);
    // RPC result goes straight back to the frontend
    res.json(result);
  } catch (err) {
    console.error("Dogecoin RPC error:", err);
    res.status(500).json({
      error: "RPC error",
      message: err.message,
      code: err.code ?? undefined,
      data: err.data ?? undefined,
    });
  }
});

// ---- Node overview / status ----
app.get('/api/node/status', async (req, res) => {
  try {
    const [
      blockchainInfo,
      networkInfo,
      mempoolInfo,
      mempoolVerbose,
      unspent
    ] = await Promise.all([
      callDogecoinRpc('getblockchaininfo', []),
      callDogecoinRpc('getnetworkinfo', []),
      callDogecoinRpc('getmempoolinfo', []),
      callDogecoinRpc('getrawmempool', [true]),     // verbose mempool
      callDogecoinRpc('listunspent', [0, 9999999, []]),
    ]);

    // Pending TXs from verbose mempool
    const pendingTxs = [];
    if (mempoolVerbose && typeof mempoolVerbose === 'object') {
      for (const [txid, info] of Object.entries(mempoolVerbose)) {
        let fee = info.fee;
        if (!fee && info.fees && typeof info.fees === 'object') {
          fee = info.fees.base ?? info.fees.modified ?? info.fees.ancestor;
        }
        pendingTxs.push({
          txid,
          fee: fee ?? null,
          size: info.size ?? null,
        });
      }
    }

    // Build "wallets" by grouping UTXOs by label
    const walletsMap = new Map();

    for (const u of unspent) {
      let label = 'default';
      try {
        if (u.address) {
          const info = await callDogecoinRpc('getaddressinfo', [u.address]);
          if (info && typeof info.label === 'string' && info.label.length > 0) {
            label = info.label;
          }
        }
      } catch (_) {
        // ignore label lookup errors, fall back to "default"
      }

      const key = label;
      if (!walletsMap.has(key)) {
        walletsMap.set(key, {
          name: key,
          balance: 0,
          unconfirmed: 0,
        });
      }
      const w = walletsMap.get(key);
      const amt = Number(u.amount || 0);
      w.balance += amt;
      if (Number(u.confirmations || 0) === 0) {
        w.unconfirmed += amt;
      }
    }

    const wallets = Array.from(walletsMap.values());

    const connected =
      networkInfo &&
      typeof networkInfo.connections === 'number' &&
      networkInfo.connections > 0;

    res.json({
      connected,
      blockchainInfo,
      networkInfo,
      mempoolInfo,
      pendingTxs,
      wallets,
    });
  } catch (err) {
    console.error('Error in /api/node/status:', err);
    res.status(500).json({
      error: 'RPC error',
      message: err.message,
    });
  }
});

// ---- Wallet transaction history ----
app.get('/api/node/history', async (req, res) => {
  try {
    // last 100 txs for all accounts, include_watchonly = true
    const txs = await callDogecoinRpc('listtransactions', ['*', 100, 0, true]);
    res.json({ txs });
  } catch (err) {
    console.error('Error in /api/node/history:', err);
    res.status(500).json({
      error: 'RPC error',
      message: err.message,
    });
  }
});

// ---- Wallet UTXOs (with labels) ----
app.get('/api/wallet/utxos', async (req, res) => {
  try {
    const unspent = await callDogecoinRpc('listunspent', [0, 9999999, []]);

    const utxos = [];
    for (const u of unspent) {
      let label = 'default';
      try {
        if (u.address) {
          const info = await callDogecoinRpc('getaddressinfo', [u.address]);
          if (info && typeof info.label === 'string' && info.label.length > 0) {
            label = info.label;
          }
        }
      } catch (_) {
        // ignore labeling issues
      }

      utxos.push({
        txid: u.txid,
        vout: u.vout,
        address: u.address,
        amount: u.amount,
        confirmations: u.confirmations,
        label,
      });
    }

    res.json({ utxos });
  } catch (err) {
    console.error('Error in /api/wallet/utxos:', err);
    res.status(500).json({
      error: 'RPC error',
      message: err.message,
    });
  }
});

// ---- Import private key (WIF) ----
app.post('/api/wallet/import-privkey', async (req, res) => {
  const { privkey, label, rescan } = req.body || {};
  if (!privkey || typeof privkey !== 'string') {
    return res.status(400).json({ error: 'privkey is required' });
  }

  try {
    const args = [privkey];

    // label (string)
    if (typeof label === 'string') {
      args.push(label);
    } else {
      args.push(''); // empty label
    }

    // rescan (bool) – if provided
    if (typeof rescan === 'boolean') {
      args.push(rescan);
    }

    await callDogecoinRpc('importprivkey', args);

    res.json({ ok: true });
  } catch (err) {
    console.error('Error in /api/wallet/import-privkey:', err);
    res.status(500).json({
      error: 'RPC error',
      message: err.message,
    });
  }
});
// ---- Load current RPC config (for UI) ----
app.get('/api/dev/rpc-config', (req, res) => {
  try {
    const url = process.env.NODE_RPC_URL || 'http://127.0.0.1:22555';
    const user = process.env.NODE_RPC_USER || '';
    const testnetRaw = process.env.TESTNET;
    const feePerKbRaw = process.env.FEE_PER_KB;

    // we return simple values; client can decide how to display
    res.json({
      url,
      user,
      testnet: testnetRaw === undefined ? '' : testnetRaw,
      feePerKb: feePerKbRaw === undefined ? '' : Number(feePerKbRaw) || ''
    });
  } catch (err) {
    console.error('Error in GET /api/dev/rpc-config:', err);
    res.status(500).json({ error: 'Failed to load RPC config', message: err.message });
  }
});

// ---------------- WALLET: SEND DOGE ----------------
// Expects body like:
// {
//   address: "Dxxx",
//   amount: "1.23" | 1.23 | "MAX",
//   utxos: [{ txid, vout }, ...],      // optional; if empty → fallback sendtoaddress
//   feeDoge: 0.02,                     // from slider (0.01–0.10)
//   fee: 0.02,                         // (fallback name)
//   feeAmount: 0.02,                   // (fallback name)
//   subtractFeeFromAmount: true/false, // optional
//   deductFeeFromTotal: true/false,    // optional
//   sendMax: true/false                // optional
// }

app.post('/api/wallet/send', async (req, res) => {
  try {
    const {
      address,
      amount,
      utxos,
      feeDoge,
      fee,
      feeAmount,
      subtractFeeFromAmount,
      deductFeeFromTotal,
      sendMax,
    } = req.body || {};

    if (!address) {
      return res.status(400).json({ error: 'Destination address is required.' });
    }

    // ---- FEE: clamp between 0.01 and 0.10 DOGE, default 0.02 ----
    let feeVal = [feeDoge, feeAmount, fee]
      .map((v) => Number(v))
      .find((v) => Number.isFinite(v) && v > 0);

    if (!Number.isFinite(feeVal)) feeVal = 0.02;
    if (feeVal < 0.01) feeVal = 0.01;
    if (feeVal > 0.10) feeVal = 0.10;

    const subtractFee =
      !!subtractFeeFromAmount || !!deductFeeFromTotal;

    const utxoList = Array.isArray(utxos)
      ? utxos.filter((u) => u && u.txid && Number.isInteger(u.vout))
      : [];

    const amtRaw =
      typeof amount === 'string' ? amount.trim() : amount;
    const wantMax =
      !!sendMax || (typeof amtRaw === 'string' && amtRaw.toUpperCase() === 'MAX');

    // ---------------- SIMPLE PATH: no UTXOs specified ----------------
    // Let Dogecoin wallet pick UTXOs via sendtoaddress.
    if (!utxoList.length) {
      let amtNum = Number(amtRaw);

      if (!Number.isFinite(amtNum) || amtNum <= 0) {
        return res
          .status(400)
          .json({ error: 'Amount must be > 0 when no UTXOs are specified.' });
      }

      // Optionally subtract fee from amount
      if (subtractFee) {
        amtNum -= feeVal;
        if (amtNum <= 0) {
          return res
            .status(400)
            .json({ error: 'Amount too small after subtracting fee.' });
        }
      }

      const params = [address, Number(amtNum.toFixed(8))];

      // Dogecoin sendtoaddress: address amount (comment) (comment_to) subtractfeefromamount
      if (subtractFee) {
        params.push('', '', true);
      }

      const txid = await callDogecoinRpc('sendtoaddress', params);

      return res.json({
        txid,
        mode: 'sendtoaddress',
        fee: feeVal,
      });
    }

    // ---------------- ADVANCED PATH: explicit UTXOs ----------------
    // Build a raw tx from selected UTXOs and broadcast.

    // Get all spendable UTXOs from node
    const allUtxos = await callDogecoinRpc('listunspent', [0, 9999999, []]);

    const utxoMap = new Map();
    for (const u of allUtxos) {
      utxoMap.set(`${u.txid}:${u.vout}`, u);
    }

    let totalIn = 0;
    const inputs = [];

    for (const { txid, vout } of utxoList) {
      const key = `${txid}:${vout}`;
      const info = utxoMap.get(key);
      if (!info) continue; // unknown to node

      totalIn += Number(info.amount || 0);
      inputs.push({ txid, vout });
    }

    if (!inputs.length) {
      return res.status(400).json({
        error: 'Selected UTXOs not found in node listunspent.',
      });
    }

    if (totalIn <= 0) {
      return res
        .status(400)
        .json({ error: 'Selected UTXOs have zero total amount.' });
    }

    // Compute send amount
    let sendAmount;

    if (wantMax) {
      // Max: spend everything from selected UTXOs minus fee
      sendAmount = totalIn - feeVal;
    } else {
      const parsedAmt = Number(amtRaw);
      if (!Number.isFinite(parsedAmt) || parsedAmt <= 0) {
        return res.status(400).json({ error: 'Invalid amount.' });
      }

      sendAmount = subtractFee ? parsedAmt - feeVal : parsedAmt;
    }

    if (sendAmount <= 0) {
      return res
        .status(400)
        .json({ error: 'Amount too small after subtracting fee.' });
    }

    // Check that inputs cover amount + fee
    if (sendAmount + feeVal - totalIn > 1e-8) {
      return res.status(400).json({
        error:
          'Not enough input value to cover amount + fee from the selected UTXOs.',
      });
    }

    const change = totalIn - (sendAmount + feeVal);

    // Outputs: main destination + optional change back to first UTXO address
    const outputs = {};
    outputs[address] = Number(sendAmount.toFixed(8));

    if (change > 0) {
      const firstKey = `${utxoList[0].txid}:${utxoList[0].vout}`;
      const firstInfo = utxoMap.get(firstKey);
      const changeAddr = firstInfo && firstInfo.address;

      if (changeAddr) {
        outputs[changeAddr] = Number(change.toFixed(8));
      }
    }

    // Create raw transaction
    const rawTx = await callDogecoinRpc('createrawtransaction', [inputs, outputs]);

    // Sign raw transaction – try with wallet, fallback to old signrawtransaction
    let signed;
    try {
      signed = await callDogecoinRpc('signrawtransactionwithwallet', [rawTx]);
    } catch (e) {
      if (
        e &&
        (e.code === -32601 ||
          (typeof e.message === 'string' &&
            e.message.includes('Method not found')))
      ) {
        // Old Dogecoin-style signer
        signed = await callDogecoinRpc('signrawtransaction', [rawTx]);
      } else {
        throw e;
      }
    }

    if (!signed || !signed.hex || signed.complete === false) {
      return res.status(500).json({
        error: 'Failed to sign raw transaction.',
        data: signed || null,
      });
    }

    // Broadcast
    const txid = await callDogecoinRpc('sendrawtransaction', [signed.hex]);

    res.json({
      txid,
      mode: 'raw',
      usedUtxos: inputs.length,
      fee: feeVal,
      totalInput: totalIn,
      change: change > 0 ? Number(change.toFixed(8)) : 0,
    });
  } catch (err) {
    console.error('Error in /api/wallet/send:', err);
    res.status(500).json({
      error: 'RPC error',
      message: err.message,
      code: err.code ?? undefined,
      data: err.data ?? undefined,
    });
  }
});


// ---- Save RPC settings into .env and update process.env ----
app.post('/api/dev/rpc-config/save', async (req, res) => {
  const { url, user, pass, testnet, feePerKb } = req.body || {};

  // If nothing was provided, bail out
  if (
    url === undefined &&
    user === undefined &&
    pass === undefined &&
    testnet === undefined &&
    feePerKb === undefined
  ) {
    return res.status(400).json({ error: 'No fields provided to update' });
  }

  try {
    let envText = '';
    if (fs.existsSync(ENV_PATH)) {
      envText = fs.readFileSync(ENV_PATH, 'utf8');
    }

    // helper to upsert KEY=VALUE in .env text, but only if value is not undefined
    function upsertEnvVar(content, key, value) {
      if (value === undefined) return content; // leave as-is
      const line = `${key}=${value ?? ''}`;
      const re = new RegExp(`^${key}=.*$`, 'm');
      if (re.test(content)) {
        return content.replace(re, line);
      }
      if (content.trim().length === 0) {
        return line + '\n';
      }
      if (!content.endsWith('\n')) {
        return content + '\n' + line + '\n';
      }
      return content + line + '\n';
    }

    envText = upsertEnvVar(envText, 'NODE_RPC_URL', url);
    envText = upsertEnvVar(envText, 'NODE_RPC_USER', user);
    envText = upsertEnvVar(envText, 'NODE_RPC_PASS', pass);
    envText = upsertEnvVar(envText, 'TESTNET', testnet);
    envText = upsertEnvVar(
      envText,
      'FEE_PER_KB',
      feePerKb === undefined ? undefined : String(feePerKb)
    );

    fs.writeFileSync(ENV_PATH, envText, 'utf8');

    // update in-memory env so new calls use it immediately
    if (url !== undefined) process.env.NODE_RPC_URL = url;
    if (user !== undefined) process.env.NODE_RPC_USER = user || '';
    if (pass !== undefined) process.env.NODE_RPC_PASS = pass || '';
    if (testnet !== undefined) process.env.TESTNET = testnet;
    if (feePerKb !== undefined) process.env.FEE_PER_KB = String(feePerKb);

    res.json({ ok: true });
  } catch (err) {
    console.error('Error saving RPC config:', err);
    res.status(500).json({
      error: 'Failed to save RPC config',
      message: err.message,
    });
  }
});


// ---- Transaction status / details ----
app.post('/api/tx/check', async (req, res) => {
  const { txid } = req.body || {};
  if (!txid || typeof txid !== 'string') {
    return res.status(400).json({ error: 'txid is required' });
  }

  try {
    // Wallet-view of the transaction (includes confirmations, details, etc.)
    const tx = await callDogecoinRpc('gettransaction', [txid, true]);
    res.json({ tx });
  } catch (err) {
    console.error('Error in /api/tx/check:', err);
    res.status(500).json({
      error: 'RPC error',
      message: err.message,
    });
  }
});

// POST /api/doginals/wallets/new
// Body: { label?: string }
app.post('/api/doginals/wallets/new', async (req, res) => {
  try {
    const rawLabel = (req.body && req.body.label) || '';
    let label = rawLabel.trim();

    if (label) {
      label = label.replace(/[^a-zA-Z0-9_-]/g, '_');
      const dir = path.join(DOGINALS_WALLETS_DIR, label);
      if (fs.existsSync(dir)) {
        return res.status(400).json({ error: 'Wallet already exists for that label' });
      }
      fs.mkdirSync(dir, { recursive: true });
    } else {
      // auto walletN
      let n = 1;
      while (true) {
        const candidate = `wallet${n}`;
        const dir = path.join(DOGINALS_WALLETS_DIR, candidate);
        if (!fs.existsSync(dir)) {
          label = candidate;
          fs.mkdirSync(dir, { recursive: true });
          break;
        }
        n++;
      }
    }

    const walletPath = getDoginalsWalletPath(label);

    // run "node doginals.js wallet new" with WALLET pointing at this path
    const result = await runDoginals(['wallet', 'new'], { walletLabel: label });

    if (!fs.existsSync(walletPath)) {
      throw new Error('Wallet file was not created');
    }

    const wallet = readDoginalsWallet(label);
    if (!wallet) throw new Error('Failed to read new wallet');

    // auto-import to dogecoin node, NO rescan (empty wallet)
    let importInfo;
    try {
      const rpcResult = await callDogecoinRpc('importprivkey', [
        wallet.privkey,
        label,
        false,
      ]);
      importInfo = { ok: true, rpcResult };
    } catch (err) {
      console.error('Auto-import error for new wallet', err);
      importInfo = { ok: false, error: err.message };
    }

    appendWalletLog(
      label,
      `Created wallet ${label} address=${wallet.address}\nCLI:\n${result.stdout}`
    );

    res.json({
      ok: true,
      label,
      address: wallet.address,
      privkey: wallet.privkey,
      cliOutput: result.stdout,
      import: importInfo,
    });
  } catch (err) {
    console.error('Error in /api/doginals/wallets/new:', err);
    res.status(500).json({
      error: 'Failed to create wallet',
      message: err.message,
    });
  }
});

// POST /api/doginals/wallets/sync
// Body: { label }
app.post('/api/doginals/wallets/sync', async (req, res) => {
  try {
    const label = (req.body && req.body.label || '').trim();
    if (!label) return res.status(400).json({ error: 'label required' });

    const w = readDoginalsWallet(label);
    if (!w) return res.status(404).json({ error: 'Wallet not found' });

    const result = await runDoginals(['wallet', 'sync'], { walletLabel: label });
    const updatedWallet = readDoginalsWallet(label);

    appendWalletLog(label, `wallet sync\n${result.stdout}`);

    res.json({
      ok: true,
      label,
      stdout: result.stdout,
      utxos: (updatedWallet && updatedWallet.utxos) || [],
      address: updatedWallet && updatedWallet.address,
    });
  } catch (err) {
    console.error('Error in /api/doginals/wallets/sync:', err);
    res.status(500).json({ error: 'Failed to sync wallet', message: err.message });
  }
});

// POST /api/doginals/wallets/split
// Body: { label, splits }
app.post('/api/doginals/wallets/split', async (req, res) => {
  try {
    const label = (req.body && req.body.label || '').trim();
    let splits = Number(req.body && req.body.splits);

    if (!label) return res.status(400).json({ error: 'label required' });
    if (!Number.isFinite(splits) || splits < 2) {
      return res.status(400).json({ error: 'splits must be >= 2' });
    }

    const w = readDoginalsWallet(label);
    if (!w) return res.status(404).json({ error: 'Wallet not found' });

    splits = Math.floor(splits);

    const result = await runDoginals(['wallet', 'split', String(splits)], {
      walletLabel: label,
    });

    // pull last 64-hex as txid (best-effort)
    const match = result.stdout.match(/[0-9a-fA-F]{64}/g);
    const txid = match ? match[match.length - 1] : null;

    const updatedWallet = readDoginalsWallet(label);

    appendWalletLog(label, `wallet split ${splits}\n${result.stdout}`);

    res.json({
      ok: true,
      label,
      splits,
      txid,
      stdout: result.stdout,
      utxos: (updatedWallet && updatedWallet.utxos) || [],
    });
  } catch (err) {
    console.error('Error in /api/doginals/wallets/split:', err);
    res.status(500).json({ error: 'Failed to split wallet', message: err.message });
  }
});

// ---------- DRC-20 mint helpers (batching + mempool handling) ----------

const DRC20_BATCH_SIZE = 12;

// extract inscription txids from doginals stdout
function parseInscriptionTxids(stdout) {
  const txids = [];
  if (!stdout) return txids;
  const re = /inscription txid:\s*([0-9a-fA-F]{64})/g;
  let m;
  while ((m = re.exec(stdout)) !== null) {
    txids.push(m[1]);
  }
  return txids;
}


// returns true once tx has at least 1 confirmation OR is no longer in mempool
async function isTxConfirmedOrGone(txid) {
  if (!txid) return true;

  // try wallet view first
  try {
    const tx = await callDogecoinRpc("gettransaction", [txid, true]);
    if (tx && typeof tx.confirmations === "number" && tx.confirmations > 0) {
      return true;
    }
  } catch (_) {
    // not in wallet or RPC error – fall through to mempool check
  }

  // fall back to mempool membership
  try {
    const mempool = await callDogecoinRpc("getrawmempool", [false]);
    if (Array.isArray(mempool)) {
      return !mempool.includes(txid);
    }
  } catch (_) {
    // if mempool can't be queried, be conservative and say "not cleared yet"
    return false;
  }

  return false;
}

// poll every 30s until tx is confirmed or gone from mempool
async function waitForTxChainClear(txid, walletLabel, logFn) {
  const log = typeof logFn === "function" ? logFn : () => {};
  let checks = 0;
  log(
    `[server] Hit mempool chain limit for wallet "${walletLabel}". Watching tx ${txid} until it confirms / leaves mempool...`
  );

  // keep going until we see it confirmed or gone
  // (user wants this to be fully automatic)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    checks += 1;
    const cleared = await isTxConfirmedOrGone(txid);
    if (cleared) {
      log(
        `[server] tx ${txid} confirmed / no longer in mempool after ${checks} checks.`
      );
      return;
    }
    log(
      `[server] tx ${txid} still in mempool after check #${checks}. Sleeping 30s...`
    );
    await sleep(30000);
  }
}


// POST /api/drc20/deploy
// Body: { label, ticker, max, limit, address? }
app.post('/api/drc20/deploy', async (req, res) => {
  try {
    const { label, ticker, max, limit, address } = req.body || {};
    const walletLabel = (label || '').trim();
    if (!walletLabel) {
      return res.status(400).json({ ok: false, error: 'label is required' });
    }

    const w = readDoginalsWallet(walletLabel);
    if (!w) {
      return res.status(404).json({ ok: false, error: 'Wallet not found' });
    }

    const tick = (ticker || '').trim();
    if (!tick || tick.length > 4) {
      return res
        .status(400)
        .json({ ok: false, error: 'Ticker must be 1–4 characters' });
    }

    const maxStr = String(max || '').trim();
    const limStr = String(limit || '').trim();
    if (!maxStr || !limStr) {
      return res
        .status(400)
        .json({ ok: false, error: 'max and limit are required' });
    }

    const deployAddress = (address || '').trim() || w.address;

    const args = ['drc-20', 'deploy', deployAddress, tick, maxStr, limStr];

    const result = await runDoginals(args, { walletLabel });

    // sync wallet.json after deploy so balances / utxos are fresh
    try {
      await runDoginals(['wallet', 'sync'], { walletLabel });
    } catch (e) {
      console.warn(
        'post-deploy wallet sync failed for',
        walletLabel,
        e.message
      );
    }

    const txids = [];
    const re = /inscription txid:\s*([0-9a-fA-F]{64})/g;
    let m;
    while ((m = re.exec(result.stdout)) !== null) {
      txids.push(m[1]);
    }

    appendWalletLog(
      walletLabel,
      `DRC20 DEPLOY ${tick} max=${maxStr} lim=${limStr} addr=${deployAddress}\n${result.stdout}`
    );

    res.json({
      ok: true,
      label: walletLabel,
      ticker: tick,
      txids,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  } catch (err) {
    console.error('Error in /api/drc20/deploy:', err);
    res.status(500).json({
      ok: false,
      error: 'Deploy failed',
      message: err.message,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    });
  }
});


// POST /api/drc20/mint
// Body: { label, ticker, amount, count, address }
app.post("/api/drc20/mint", async (req, res) => {
  const combinedTxids = [];
  let combinedStdout = "";
  let combinedStderr = "";

  try {
    const { label, ticker, amount, count, address } = req.body || {};
    const walletLabel = (label || "").trim();
    if (!walletLabel) {
      return res
        .status(400)
        .json({ ok: false, error: "label is required" });
    }

    const w = readDoginalsWallet(walletLabel);
    if (!w) {
      return res
        .status(404)
        .json({ ok: false, error: "Wallet not found" });
    }

    const tick = (ticker || "").trim();
    if (!tick || tick.length > 4) {
      return res.status(400).json({
        ok: false,
        error: "Ticker must be 1–4 characters",
      });
    }

    const amtStr = String(amount || "").trim();
    if (!amtStr) {
      return res
        .status(400)
        .json({ ok: false, error: "amount is required" });
    }

    const countNum = Number(count || 1);
    if (!Number.isFinite(countNum) || countNum <= 0) {
      return res.status(400).json({
        ok: false,
        error: "count must be positive",
      });
    }

    const totalRequested = Math.floor(countNum);
    const targetAddress = (address || "").trim() || w.address;

    let mintedSoFar = 0;

    const logLine = (line) => {
      combinedStdout += (line || "") + "\n";
    };

    // MAIN LOOP: mint in batches of DRC20_BATCH_SIZE, but
    // wait for previous batch's last tx to confirm before starting the next.
    while (mintedSoFar < totalRequested) {
      const batchCount = Math.min(
        DRC20_BATCH_SIZE,
        totalRequested - mintedSoFar
      );

      // If we already minted a batch, wait for last inscription of that batch
      // to confirm / leave mempool, then sync wallet before the next batch.
      if (mintedSoFar > 0 && combinedTxids.length) {
        const lastTxid =
          combinedTxids[combinedTxids.length - 1];

        await waitForTxChainClear(lastTxid, walletLabel, logLine);

        // real wallet sync (no pending-txs.json at this point)
        try {
          const syncResult = await runDoginals(["wallet", "sync"], {
            walletLabel,
          });
          combinedStdout += syncResult.stdout || "";
        } catch (syncErr) {
          console.warn(
            "pre-batch wallet sync failed for",
            walletLabel,
            syncErr.message
          );
        }
      }

      const args = [
        "drc-20",
        "mint",
        targetAddress,
        tick,
        amtStr,
        String(batchCount),
      ];

      try {
        // Normal batch: doginals prints all "Minting... / broadcasting..."
        const result = await runDoginals(args, { walletLabel });
        combinedStdout += result.stdout || "";
        combinedStderr += result.stderr || "";

        const txids = parseInscriptionTxids(result.stdout || "");
        if (txids.length) {
          combinedTxids.push(...txids);
        }

        mintedSoFar += batchCount;

        // keep wallet.json fresh (includes zero-conf utxos)
        try {
          const syncResult2 = await runDoginals(["wallet", "sync"], {
            walletLabel,
          });
          combinedStdout += syncResult2.stdout || "";
        } catch (e) {
          console.warn(
            "post-batch wallet sync failed for",
            walletLabel,
            e.message
          );
        }
      } catch (err) {
        // We only get here if the entire batch call to doginals failed
        combinedStdout += err.stdout || "";
        combinedStderr += err.stderr || "";

        const out = (err.stdout || "") + " " + (err.stderr || "");
        const isMempoolChain =
          out.includes("too-long-mempool-chain") ||
          out.includes("64: too-long-mempool-chain");

        if (!isMempoolChain) {
          // some other error – bubble it up
          throw err;
        }

        // ---- Fallback: mempool chain error *inside* a batch ----

        // txids that succeeded in this partial batch
        const okTxids = parseInscriptionTxids(err.stdout || "");
        if (okTxids.length) {
          combinedTxids.push(...okTxids);
        }

        const lastOkTxid =
          okTxids.length > 0 ? okTxids[okTxids.length - 1] : null;

        if (lastOkTxid) {
          await waitForTxChainClear(
            lastOkTxid,
            walletLabel,
            logLine
          );
        } else if (combinedTxids.length) {
          // fall back to last *overall* txid we know about
          const lastOverall =
            combinedTxids[combinedTxids.length - 1];
          await waitForTxChainClear(
            lastOverall,
            walletLabel,
            logLine
          );
        } else {
          logLine(
            "[server] Hit mempool chain limit but no inscription txid found; waiting 30s before retrying..."
          );
          await sleep(30000);
        }

        // First wallet sync: this will *only* rebroadcast pending-txs.json
        // because of doginals.js main() early-return logic.
        try {
          const rebroadcastResult = await runDoginals(
            ["wallet", "sync"],
            { walletLabel }
          );
          combinedStdout += rebroadcastResult.stdout || "";
          combinedStderr += rebroadcastResult.stderr || "";

          const rebroadcastTxids = parseInscriptionTxids(
            rebroadcastResult.stdout || ""
          );
          if (rebroadcastTxids.length) {
            combinedTxids.push(...rebroadcastTxids);
          }
        } catch (rebErr) {
          combinedStdout +=
            "\n[server] Error while rebroadcasting pending txs via wallet sync: " +
            (rebErr.message || "") +
            "\n";
          throw rebErr;
        }

        // Second wallet sync: now really refresh utxos to match node.
        try {
          const syncResult3 = await runDoginals(["wallet", "sync"], {
            walletLabel,
          });
          combinedStdout += syncResult3.stdout || "";
        } catch (syncErr3) {
          console.warn(
            "wallet sync after pending rebroadcast failed for",
            walletLabel,
            syncErr3.message
          );
        }

        // At this point doginals has built the full batch and
        // pending-txs.json has been rebroadcast, so we count this batch
        // as minted and move on.
        mintedSoFar += batchCount;
      }
    } // end while

    appendWalletLog(
      walletLabel,
      `DRC20 MINT ${tick} amount=${amtStr} count=${totalRequested} addr=${targetAddress}\n${combinedStdout}`
    );

    res.json({
      ok: true,
      label: walletLabel,
      ticker: tick,
      amount: amtStr,
      count: totalRequested,
      txids: combinedTxids,
      stdout: combinedStdout,
      stderr: combinedStderr,
    });
  } catch (err) {
    console.error("Error in /api/drc20/mint:", err);
    res.status(500).json({
      ok: false,
      error: "Mint failed",
      message: err.message,
      stdout: combinedStdout || err.stdout || "",
      stderr: combinedStderr || err.stderr || "",
    });
  }
});

// --- helper: distinct utxo keys as "txid:vout" ---
function getDistinctUtxoKeys(wallet) {
  if (!wallet || !Array.isArray(wallet.utxos)) return [];
  const keys = [];
  const seen = new Set();
  for (const u of wallet.utxos) {
    if (!u || !u.txid || typeof u.vout === 'undefined') continue;
    const key = `${u.txid}:${u.vout}`;
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

// --- helper: small sleep ---
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calcWalletBalanceDoge(wallet) {
  if (!wallet || !Array.isArray(wallet.utxos)) return null;
  const seen = new Set();
  let totalSats = 0;

  for (const u of wallet.utxos) {
    if (!u || !u.txid) continue;
    const key = `${u.txid}:${u.vout}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const s = Number(u.satoshis || 0);
    if (Number.isFinite(s)) totalSats += s;
  }

  return totalSats / 1e8;
}

function atomicWriteJson(filePath, dataObj) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(dataObj, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}


// --- DRC-20 streaming mint (waves of 12, mempool-aware, no round UTXO tracking) ---
// --- DRC-20 streaming mint (waves of 12, mempool-aware, no round UTXO tracking) ---
app.get('/api/drc20/mint-stream', async (req, res) => {
  // ----- SSE HEADERS -----
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  let targetAddress = null;

  const { label, ticker, amount, count, address } = req.query || {};

  const walletLabel = (label || '').trim();
  const tick = (ticker || '').trim();
  const amtStr = String(amount || '').trim();
  const total = Number(count || 0);
  const MAX_PER_WAVE = 12;

  // --- LOGGING ADDITIONS (ONLY) ---
  const startedAtIso = new Date().toISOString();
  let startBalance = null;
  let endBalance = null;
  const transcript = [];
  const logToTranscript = (line) => {
    const s = String(line || '').trimEnd();
    if (!s) return;
    transcript.push(s);
  };
  const finalizeStreamLog = (status, extra) => {
    try {
      const header = `DRC20 MINT ${tick} amount=${amtStr} total=${total} addr=${targetAddress}`;
      const meta = [
        `status=${status}`,
        `startedAt=${startedAtIso}`,
        `finishedAt=${new Date().toISOString()}`,
        `completed=${extra && typeof extra.completed === 'number' ? extra.completed : '?'}`,
        `cancelled=${cancelled ? 'true' : 'false'}`,
        `startBalance=${startBalance === null ? 'null' : startBalance}`,
        `endBalance=${endBalance === null ? 'null' : endBalance}`,
      ].join('\n');

      const body = transcript.length ? `\n${transcript.join('\n')}` : '';
      appendWalletLog(walletLabel, `${header}\n${meta}${body}`);
    } catch (e) {
      console.error('finalizeStreamLog error:', e);
    }
  };
  let finalizedOnce = false;
  const finalizeOnce = (status, extra) => {
    if (finalizedOnce) return;
    finalizedOnce = true;
    finalizeStreamLog(status, extra);
  };
  // --- END LOGGING ADDITIONS ---

  let cancelled = false;
  req.on('close', () => {
    cancelled = true;
  });

  // ----- SSE HELPERS -----
  const sendLog = (line) => {
    const s = String(line || '').trimEnd();
    logToTranscript(s); // logging addition
    sseEvent(res, 'log', { line: s });
  };

  const sendProgress = (completed, totalMints) =>
    sseEvent(res, 'progress', { completed, total: totalMints });

  // ----- VALIDATION -----
  if (!walletLabel) {
    sseEvent(res, 'mintError', { message: 'label is required' });
    // logging addition
    finalizeOnce('error', { completed: 0 });
    return res.end();
  }

  let wallet = readDoginalsWallet(walletLabel);
  if (!wallet) {
    sseEvent(res, 'mintError', { message: 'wallet not found' });
    // logging addition
    finalizeOnce('error', { completed: 0 });
    return res.end();
  }

  if (!tick || tick.length > 4) {
    sseEvent(res, 'mintError', { message: 'ticker must be 1–4 characters' });
    // logging addition
    finalizeOnce('error', { completed: 0 });
    return res.end();
  }
  if (!amtStr) {
    sseEvent(res, 'mintError', { message: 'amount is required' });
    // logging addition
    finalizeOnce('error', { completed: 0 });
    return res.end();
  }
  if (!Number.isFinite(total) || total <= 0) {
    sseEvent(res, 'mintError', { message: 'total mints must be > 0' });
    // logging addition
    finalizeOnce('error', { completed: 0 });
    return res.end();
  }
  targetAddress = (address || '').trim() || wallet.address;
  if (!targetAddress) {
    sseEvent(res, 'mintError', { message: 'target address missing' });
    // logging addition
    finalizeOnce('error', { completed: 0 });
    return res.end();
  }

  // ----- SIMPLE HELPERS -----

  // one-shot wallet sync
  async function syncWalletOnce() {
    try {
      sendLog(`[server] syncing wallet ${walletLabel}...`);
      const syncResult = await runDoginals(['wallet', 'sync'], { walletLabel });
      const firstLine = (syncResult.stdout || '')
        .split(/\r?\n/)
        .find((l) => l.trim());
      if (firstLine) {
        sendLog(`[wallet-sync] ${firstLine}`);
      }
    } catch (err) {
      sendLog(
        `[server] wallet sync error (single attempt): ${err.message || String(
          err
        )}`
      );
      return null;
    }

    const w = readDoginalsWallet(walletLabel);
    if (!w) {
      sendLog('[server] warning: wallet json missing after sync');
      return null;
    }
    return w;
  }

  // wallet sync with retry loop
  async function syncWalletWithRetry(maxTries = 5, delayMs = 30000) {
    for (let attempt = 1; attempt <= maxTries && !cancelled; attempt++) {
      const w = await syncWalletOnce();
      if (w) {
        if (attempt > 1) {
          sendLog(
            `[server] wallet sync succeeded on attempt ${attempt}/${maxTries}`
          );
        }
        return w;
      }
      if (attempt < maxTries) {
        sendLog(
          `[server] wallet sync failed (attempt ${attempt}/${maxTries}), retrying in ${
            delayMs / 1000
          }s...`
        );
        await sleep(delayMs);
      }
    }
    sendLog(
      `[server] wallet sync failed after ${maxTries} attempts; aborting mint stream.`
    );
    return null;
  }

  // delete this wallet's pending-txs.json (if any)
  async function deletePendingFile() {
    const walletPath = getDoginalsWalletPath(walletLabel);
    const pendingPath = path.join(path.dirname(walletPath), 'pending-txs.json');
    try {
      await fs.promises.unlink(pendingPath);
      sendLog(
        `[server] deleted pending-txs.json at "${pendingPath}" after chain-limit`
      );
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        sendLog(
          `[server] pending-txs.json not found at "${pendingPath}" (nothing to delete)`
        );
      } else {
        sendLog(
          `[server] failed to delete pending-txs.json: ${
            err.message || String(err)
          }`
        );
      }
    }
  }

  // run a single mint wave of N inscriptions (up to 12)
  async function runMintWave(waveCount) {
    return new Promise((resolve) => {
      const args = [
        'drc-20',
        'mint',
        targetAddress,
        tick,
        amtStr,
        String(waveCount),
      ];

      const env = {
        ...process.env,
        WALLET: getDoginalsWalletPath(walletLabel),
      };

      sendLog(
        `[server] starting wave of ${waveCount} mints for ${tick} to ${targetAddress}`
      );

      const child = spawn(process.execPath, [DOGINALS_SCRIPT, ...args], {
        cwd: path.join(__dirname, 'scripts'),
        env,
      });

      let stdoutBuf = '';
      let stderrBuf = '';
      const mintedTxids = [];

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdoutBuf += text;

        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          sendLog(line);

          const m = line.match(/inscription txid:\s*([0-9a-fA-F]{64})/);
          if (m) {
            mintedTxids.push(m[1]);
          }
        }
      });

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderrBuf += text;
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          sendLog(`[stderr] ${line}`);
        }
      });

      const finish = (code) => {
        const mergedOut = (stdoutBuf || '') + '\n' + (stderrBuf || '');
        const isMempoolChain =
          mergedOut.includes('too-long-mempool-chain') ||
          mergedOut.includes('64: too-long-mempool-chain');

        resolve({
          exitCode: code,
          chainLimit: isMempoolChain,
          mintedTxids,
          stdout: stdoutBuf,
          stderr: stderrBuf,
        });
      };

      child.on('close', (code) => finish(code));
      child.on('error', () => finish(1));
    });
  }

  // =========================================================
  // ✅ NEW: HANDOFF helper → proxy /api/drc20/multi-mint-stream SSE
  // =========================================================
  async function handoffToMultiMintStream() {
    // We proxy the SSE output so the frontend can keep using mint-stream.
    // Payload uses ONE job (the same targetAddress + total count).
    const payload = {
      label: walletLabel,
      ticker: tick,
      amount: amtStr,
      jobs: [
        {
          address: targetAddress,
          count: total,
        },
      ],
    };

    const http = require('http');
    const port =
      (req.socket && req.socket.localPort) ||
      (process.env.PORT ? Number(process.env.PORT) : 3000);

    const pathUrl =
      '/api/drc20/multi-mint-stream?data=' +
      encodeURIComponent(JSON.stringify(payload));

    sendLog(
      `[server] multi-utxo detected → handing off to ${pathUrl} (proxying SSE)`
    );

    return new Promise((resolve) => {
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'GET',
          path: pathUrl,
          headers: {
            // keep SSE semantics
            Accept: 'text/event-stream',
          },
        },
        (upstreamRes) => {
          upstreamRes.on('data', (chunk) => {
            if (cancelled) return;
            res.write(chunk);
          });

          upstreamRes.on('end', () => {
            resolve();
          });

          upstreamRes.on('error', (e) => {
            if (!cancelled) {
              sseEvent(res, 'mintError', {
                message: `handoff upstream error: ${e.message || String(e)}`,
              });
            }
            resolve();
          });
        }
      );

      upstream.on('error', (e) => {
        if (!cancelled) {
          sseEvent(res, 'mintError', {
            message: `handoff request failed: ${e.message || String(e)}`,
          });
        }
        resolve();
      });

      // If client disconnects, abort upstream
      req.on('close', () => {
        try {
          upstream.destroy();
        } catch (_) {}
      });

      upstream.end();
    });
  }
  // =========================================================

  // ----- INITIAL SYNC -----
  (async () => {
    // initial sync to make sure wallet + utxos are fresh
    wallet = await syncWalletWithRetry();
    if (!wallet) {
      sseEvent(res, 'mintError', {
        message: 'wallet sync failed repeatedly before minting',
      });
      // logging addition
      // capture start balance (best effort)
      finalizeOnce('error', { completed: 0 });
      return res.end();
    }
    startBalance = calcWalletBalanceDoge(wallet);

    const utxoCount = Array.isArray(wallet.utxos) ? wallet.utxos.length : 0;
    sendLog(
      `[server] ${utxoCount} UTXOs detected → starting mempool-aware bulk minting`
    );

    // =========================================================
    // ✅ NEW: Decide mode
    // - 1 UTXO → run THIS mint-stream logic (single-UTXO gating)
    // - >1 UTXO → handoff to multi-mint-stream (existing functionality)
    // =========================================================
    if (utxoCount > 1) {
      // Let multi-mint-stream do the real work; we just proxy SSE.
      await handoffToMultiMintStream();

      // Best-effort final balance capture for this wrapper route’s log
      try {
        await runDoginals(['wallet', 'sync'], { walletLabel });
      } catch (_) {}
      endBalance = calcWalletBalanceDoge(readDoginalsWallet(walletLabel));

      // Mark as delegated in this route’s wallet log
      finalizeOnce(cancelled ? 'cancelled' : 'delegated-to-multi', { completed: 0 });
      return res.end();
    }
    // =========================================================

    // Tell frontend job info
    sseEvent(res, 'init', { ticker: tick, total });

    // ----- MAIN LOOP STATE -----
    let completed = 0;
    const allTxids = [];
    let lastSuccessfulTxid = null;

    try {
      while (!cancelled && completed < total) {
        const remaining = total - completed;
        if (remaining <= 0) break;

        const waveCount = Math.min(MAX_PER_WAVE, remaining);

        // ---- MAIN WAVE ----
        const wave = await runMintWave(waveCount);
        if (cancelled) break;

        // count whatever succeeded in this wave (even on chain-limit)
        if (wave.mintedTxids.length) {
          for (const txid of wave.mintedTxids) {
            if (!allTxids.includes(txid)) {
              allTxids.push(txid);
            }
          }
          completed += wave.mintedTxids.length;
          lastSuccessfulTxid =
            wave.mintedTxids[wave.mintedTxids.length - 1] || lastSuccessfulTxid;
          sendProgress(completed, total);
        }

        // =========================================================
        // ✅ Single-UTXO behavior stays as-is:
        // On SUCCESSFUL wave, wait for last txid to confirm before proceeding
        // =========================================================
        if (wave.exitCode === 0 && !wave.chainLimit) {
          let watchTxid =
            (wave.mintedTxids && wave.mintedTxids.length
              ? wave.mintedTxids[wave.mintedTxids.length - 1]
              : null) || lastSuccessfulTxid;

          if (watchTxid) {
            sendLog(
              `[server] wave complete; waiting for last wave tx to confirm before next batch: ${watchTxid}`
            );
            await waitForTxChainClear(watchTxid, walletLabel, sendLog);

            // sync once after confirmation so wallet JSON reflects returned UTXO
            wallet = await syncWalletWithRetry();
            if (!wallet) {
              sseEvent(res, 'mintError', {
                message:
                  'wallet sync failed repeatedly after wave confirmation wait. Aborting mint.',
                completed,
                total,
              });
              finalizeOnce('error', { completed });
              return res.end();
            }
          } else {
            sendLog(
              '[server] wave complete but no txid found to watch; sleeping 30s before next batch...'
            );
            await sleep(30000);
            wallet = await syncWalletWithRetry();
            if (!wallet) {
              sseEvent(res, 'mintError', {
                message:
                  'wallet sync failed repeatedly after wave sleep. Aborting mint.',
                completed,
                total,
              });
              finalizeOnce('error', { completed });
              return res.end();
            }
          }

          continue;
        }
        // =========================================================

        // some hard error (non-zero exit, not mempool-related)
        if (wave.exitCode !== 0 && !wave.chainLimit) {
          sendLog(`[server] doginals exited with code ${wave.exitCode}`);
          sseEvent(res, 'mintError', {
            message: 'mint wave failed',
            stdout: wave.stdout,
            stderr: wave.stderr,
            completed,
            total,
          });
          // logging addition
          finalizeOnce('error', { completed });
          return res.end();
        }

        // ---- MEMPOOL CHAIN LIMIT PATH ----
        sendLog(
          '[server] mempool chain limit hit – deleting pending-txs.json and syncing wallet...'
        );
        await deletePendingFile();

        // if we already fulfilled everything via partial success, bail cleanly
        if (completed >= total) {
          break;
        }

        // sync wallet, then try ONE test wave
        wallet = await syncWalletWithRetry();
        if (!wallet) {
          sseEvent(res, 'mintError', {
            message:
              'wallet sync failed repeatedly after chain-limit. Aborting mint.',
            completed,
            total,
          });
          // logging addition
          finalizeOnce('error', { completed });
          return res.end();
        }

        const remainingAfter = total - completed;
        const testWaveCount = Math.min(MAX_PER_WAVE, remainingAfter);

        sendLog(
          `[server] attempting single test wave of ${testWaveCount} after sync...`
        );

        const testWave = await runMintWave(testWaveCount);
        if (cancelled) break;

        if (testWave.mintedTxids.length) {
          for (const txid of testWave.mintedTxids) {
            if (!allTxids.includes(txid)) {
              allTxids.push(txid);
            }
          }
          completed += testWave.mintedTxids.length;
          lastSuccessfulTxid =
            testWave.mintedTxids[testWave.mintedTxids.length - 1] ||
            lastSuccessfulTxid;
          sendProgress(completed, total);
        }

        // =========================================================
        // ✅ Single-UTXO behavior stays as-is:
        // If test wave succeeds, ALSO wait for its last txid to confirm
        // =========================================================
        if (testWave.exitCode === 0 && !testWave.chainLimit) {
          sendLog(
            '[server] test wave succeeded after sync; waiting for last test-wave tx to confirm before resuming...'
          );

          let watchTxid =
            (testWave.mintedTxids && testWave.mintedTxids.length
              ? testWave.mintedTxids[testWave.mintedTxids.length - 1]
              : null) || lastSuccessfulTxid;

          if (watchTxid) {
            sendLog(
              `[server] waiting for last test-wave tx to confirm: ${watchTxid}`
            );
            await waitForTxChainClear(watchTxid, walletLabel, sendLog);

            wallet = await syncWalletWithRetry();
            if (!wallet) {
              sseEvent(res, 'mintError', {
                message:
                  'wallet sync failed repeatedly after test-wave confirmation wait. Aborting mint.',
                completed,
                total,
              });
              finalizeOnce('error', { completed });
              return res.end();
            }
          } else {
            sendLog(
              '[server] test wave succeeded but no txid found to watch; sleeping 30s before resuming...'
            );
            await sleep(30000);
            wallet = await syncWalletWithRetry();
            if (!wallet) {
              sseEvent(res, 'mintError', {
                message:
                  'wallet sync failed repeatedly after test-wave sleep. Aborting mint.',
                completed,
                total,
              });
              finalizeOnce('error', { completed });
              return res.end();
            }
          }

          sendLog(
            '[server] test wave confirmed + wallet synced; resuming normal bulk minting...'
          );
          continue;
        }
        // =========================================================

        // test wave hard error (not chain-limit) → abort
        if (testWave.exitCode !== 0 && !testWave.chainLimit) {
          sendLog(
            `[server] test wave failed with code ${testWave.exitCode} (non chain-limit)`
          );
          sseEvent(res, 'mintError', {
            message:
              'test wave after chain-limit failed with non mempool error',
            stdout: testWave.stdout,
            stderr: testWave.stderr,
            completed,
            total,
          });
          // logging addition
          finalizeOnce('error', { completed });
          return res.end();
        }

        // test wave ALSO chain-limit → now we must wait for a confirmation
        sendLog(
          '[server] still hitting mempool chain limit after sync; waiting for last successful tx to confirm before resuming...'
        );

        let watchTxid = lastSuccessfulTxid;
        if (!watchTxid && allTxids.length) {
          watchTxid = allTxids[allTxids.length - 1];
        }

        if (watchTxid) {
          await waitForTxChainClear(watchTxid, walletLabel, sendLog);
        } else {
          sendLog(
            '[server] no known successful txid to watch; sleeping 30s before retry...'
          );
          await sleep(30000);
        }

        // sync once more after confirmation / wait
        wallet = await syncWalletWithRetry();
        if (!wallet) {
          sseEvent(res, 'mintError', {
            message:
              'wallet sync failed repeatedly after waiting for confirmation. Aborting mint.',
            completed,
            total,
          });
          // logging addition
          finalizeOnce('error', { completed });
          return res.end();
        }

        sendLog(
          '[server] confirmation wait complete, wallet synced – resuming bulk minting...'
        );
      }

      // ----- DONE -----
      sseEvent(res, 'done', {
        completed,
        total,
        txids: allTxids,
      });

      try {
        await runDoginals(['wallet', 'sync'], { walletLabel });
      } catch (_) {}
      endBalance = calcWalletBalanceDoge(readDoginalsWallet(walletLabel));

      // logging addition
      finalizeOnce(cancelled ? 'cancelled' : 'done', { completed });
    } catch (err) {
      sseEvent(res, 'mintError', {
        message: err.message || String(err),
      });

      // capture end balance (best effort)
      try {
        await runDoginals(['wallet', 'sync'], { walletLabel });
      } catch (_) {}
      endBalance = calcWalletBalanceDoge(readDoginalsWallet(walletLabel));

      // logging addition
      finalizeOnce('error', { completed });
    } finally {
      // logging addition: if client disconnected mid-run before we hit done/error paths
      if (cancelled) {
        // don't clobber if already finalized
        finalizeOnce('cancelled', { completed });
      }
      res.end();
    }
  })();
});




app.get('/api/drc20/multi-mint-stream', async (req, res) => {
  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  let cancelled = false;
  req.on("close", () => { cancelled = true });

  // -------------------- Parse request --------------------
  let raw = req.query.data;
  if (!raw) {
    sseEvent(res, "mintError", { message: "Missing payload." });
    // logging: can't log to wallet without label; just end
    return res.end();
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    sseEvent(res, "mintError", { message: "Invalid JSON payload." });
    return res.end();
  }

  const walletLabel = (payload.label || "").trim();
  const ticker = (payload.ticker || "").trim();
  const amount = String(payload.amount || "").trim();
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];

 // total mints to complete across ALL jobs (must exist before finalize logging)
 const grandTotal = jobs.reduce((acc, j) => acc + (Number.isFinite(Number(j?.count)) ? Number(j.count) : 0), 0);

  // --- LOGGING ADDITIONS (ONLY) ---
  const startedAtIso = new Date().toISOString();
  let startBalance = null;
  let endBalance = null;
  const transcript = [];
  const logToTranscript = (line) => {
    const s = String(line || "").trimEnd();
    if (!s) return;
    transcript.push(s);
  };
  const finalizeMultiStreamLog = (status, extra) => {
    try {
      const header = `DRC20 MULTI MINT ${ticker} amount=${amount} jobs=${jobs.length} total=${grandTotal}`;
      const meta = [
        `status=${status}`,
        `startedAt=${startedAtIso}`,
        `finishedAt=${new Date().toISOString()}`,
        `completed=${extra && typeof extra.completed === "number" ? extra.completed : "?"}`,
        `cancelled=${cancelled ? "true" : "false"}`,
        `startBalance=${startBalance === null ? 'null' : startBalance}`,
        `endBalance=${endBalance === null ? 'null' : endBalance}`,
      ].join("\n");


      const body = transcript.length ? `\n${transcript.join("\n")}` : "";
      appendWalletLog(walletLabel, `${header}\n${meta}${body}`);
    } catch (e) {
      console.error("finalizeMultiStreamLog error:", e);
    }
  };
  let finalizedOnce = false;
  const finalizeOnce = (status, extra) => {
    if (finalizedOnce) return;
    finalizedOnce = true;
    // only log if we actually have a wallet label
    if (walletLabel) finalizeMultiStreamLog(status, extra);
  };
  // --- END LOGGING ADDITIONS ---

  if (!walletLabel) {
    sseEvent(res, "mintError", { message: "label missing" });
    finalizeOnce("error", { completed: 0 });
    return res.end();
  }
  if (!ticker || ticker.length > 4) {
    sseEvent(res, "mintError", { message: "invalid ticker" });
    finalizeOnce("error", { completed: 0 });
    return res.end();
  }
  if (!amount) {
    sseEvent(res, "mintError", { message: "invalid amount" });
    finalizeOnce("error", { completed: 0 });
    return res.end();
  }
  if (!jobs.length) {
    sseEvent(res, "mintError", { message: "no mint jobs provided" });
    finalizeOnce("error", { completed: 0 });
    return res.end();
  }

  // SSE helper fns
  const log = (line) => {
    const s = String(line || "").trimEnd();
    logToTranscript(s); // logging addition
    sseEvent(res, "log", { line: s });
  };

  const progress = (completed, total) =>
    sseEvent(res, "progress", { completed, total });

  // Tell UI the grand total
  sseEvent(res, "init", { ticker, total: grandTotal });

  // Required: your existing helpers from mint-stream
  const MAX_WAVE = 12;

  async function syncWalletOnce() {
    try {
      const syncResult = await runDoginals(["wallet", "sync"], { walletLabel });
      const first = (syncResult.stdout || "").split(/\r?\n/).find(l => l.trim());
      if (first) log(`[wallet-sync] ${first}`);
    } catch (err) {
      log(`[server] wallet sync error: ${err.message}`);
      return null;
    }
    const w = readDoginalsWallet(walletLabel);
    return w || null;
  }

  async function syncWalletWithRetry(maxTries = 5, delayMs = 30000) {
    for (let a = 1; a <= maxTries && !cancelled; a++) {
      const w = await syncWalletOnce();
      if (w) {
        if (a > 1) log(`[server] wallet sync succeeded on attempt ${a}/${maxTries}`);
        return w;
      }
      if (a < maxTries) {
        log(`[server] wallet sync failed (#${a}); retrying in ${delayMs / 1000}s`);
        await sleep(delayMs);
      }
    }
    log(`[server] wallet sync failed after retries`);
    return null;
  }

  async function deletePending() {
    const walletPath = getDoginalsWalletPath(walletLabel);
    const pending = path.join(path.dirname(walletPath), "pending-txs.json");
    try {
      await fs.promises.unlink(pending);
      log(`[server] deleted pending-txs.json`);
    } catch (e) {
      if (e.code === "ENOENT") {
        log(`[server] no pending-txs.json to delete`);
      } else {
        log(`[server] failed to delete pending-txs.json: ${e.message}`);
      }
    }
  }

  async function runWave(count, targetAddress) {
    return new Promise((resolve) => {
      const args = [
        "drc-20",
        "mint",
        targetAddress,
        ticker,
        amount,
        String(count),
      ];

      const env = { ...process.env, WALLET: getDoginalsWalletPath(walletLabel) };

      log(`[server] starting wave of ${count} → ${targetAddress}`);

      const child = spawn(process.execPath, [DOGINALS_SCRIPT, ...args], {
        cwd: path.join(__dirname, "scripts"),
        env,
      });

      let stdoutBuf = "";
      let stderrBuf = "";
      const txids = [];

      child.stdout.on("data", (chunk) => {
        const txt = chunk.toString();
        stdoutBuf += txt;
        for (const line of txt.split(/\r?\n/)) {
          if (!line.trim()) continue;
          log(line);
          const m = line.match(/inscription txid:\s*([0-9a-fA-F]{64})/);
          if (m) txids.push(m[1]);
        }
      });

      child.stderr.on("data", (chunk) => {
        const txt = chunk.toString();
        stderrBuf += txt;
        for (const line of txt.split(/\r?\n/)) {
          if (!line.trim()) continue;
          log(`[stderr] ${line}`);
        }
      });

      child.on("close", (code) => {
        const merged = stdoutBuf + "\n" + stderrBuf;
        const chainLimit =
          merged.includes("too-long-mempool-chain") ||
          merged.includes("64: too-long-mempool-chain");

        resolve({
          exitCode: code,
          chainLimit,
          mintedTxids: txids,
          stdout: stdoutBuf,
          stderr: stderrBuf,
        });
      });

      child.on("error", () => {
        resolve({
          exitCode: 1,
          chainLimit: false,
          mintedTxids: [],
          stdout: stdoutBuf,
          stderr: stderrBuf,
        });
      });
    });
  }

  // WATCH CONFIRMATION (uses your existing function)
  async function waitForTxToClear(txid) {
    await waitForTxChainClear(txid, walletLabel, log);
  }

  // -------------------- MAIN MULTI-JOB EXECUTION --------------------

  (async () => {
    let wallet = await syncWalletWithRetry();
    if (!wallet) {
      sseEvent(res, "mintError", { message: "wallet sync failed before mint" });
      finalizeOnce("error", { completed: 0 });
      return res.end();
    }
    startBalance = calcWalletBalanceDoge(wallet);
    let completed = 0;
    let globalLastTxid = null;

    try {
      for (let jobIndex = 0; jobIndex < jobs.length && !cancelled; jobIndex++) {
        const job = jobs[jobIndex];
        const targetAddress = (job.address || "").trim();
        const needed = Number(job.count || 0);

        if (!targetAddress || needed <= 0) {
          log(`[server] skipping invalid job: ${JSON.stringify(job)}`);
          continue;
        }

        log(`\n[server] === START JOB ${jobIndex + 1}/${jobs.length} → ${targetAddress} (${needed} mints) ===`);

        let jobCompleted = 0;

        while (!cancelled && jobCompleted < needed) {
          const remaining = needed - jobCompleted;
          const waveCount = Math.min(MAX_WAVE, remaining);

          // ---- Run wave ----
          const wave = await runWave(waveCount, targetAddress);

          if (wave.mintedTxids.length) {
            jobCompleted += wave.mintedTxids.length;
            completed += wave.mintedTxids.length;
            globalLastTxid = wave.mintedTxids[wave.mintedTxids.length - 1];
            progress(completed, grandTotal);
          }

          // normal success
          if (wave.exitCode === 0 && !wave.chainLimit) continue;

          // hard (non-mempool) error
          if (wave.exitCode !== 0 && !wave.chainLimit) {
            sseEvent(res, "mintError", {
              message: "Wave failed",
              stdout: wave.stdout,
              stderr: wave.stderr,
              completed,
              total: grandTotal,
            });
            finalizeOnce("error", { completed });
            return res.end();
          }

          // --- chain limit path ---
          log("[server] mempool chain limit → deleting pending file");
          await deletePending();

          if (jobCompleted >= needed) break;

          wallet = await syncWalletWithRetry();
          if (!wallet) {
            sseEvent(res, "mintError", { message: "wallet sync failed (post-chain-limit)" });
            finalizeOnce("error", { completed });
            return res.end();
          }

          // test wave
          const testRemaining = needed - jobCompleted;
          const testCount = Math.min(MAX_WAVE, testRemaining);
          log(`[server] test wave: ${testCount}`);
          const testWave = await runWave(testCount, targetAddress);

          if (testWave.mintedTxids.length) {
            jobCompleted += testWave.mintedTxids.length;
            completed += testWave.mintedTxids.length;
            globalLastTxid =
              testWave.mintedTxids[testWave.mintedTxids.length - 1] ||
              globalLastTxid;
            progress(completed, grandTotal);
          }

          if (testWave.exitCode === 0 && !testWave.chainLimit) continue;

          if (testWave.exitCode !== 0 && !testWave.chainLimit) {
            sseEvent(res, "mintError", {
              message: "Test wave non-mempool error",
              stdout: testWave.stdout,
              stderr: testWave.stderr,
            });
            finalizeOnce("error", { completed });
            return res.end();
          }

          // test wave also chain-limit
          if (globalLastTxid) {
            await waitForTxToClear(globalLastTxid);
          } else {
            log("[server] no tx to watch, sleeping 30s...");
            await sleep(30000);
          }

          wallet = await syncWalletWithRetry();
          if (!wallet) {
            sseEvent(res, "mintError", {
              message: "wallet sync failed after confirmation wait",
            });
            finalizeOnce("error", { completed });
            return res.end();
          }

          log("[server] resume minting after confirmation");
        }

        log(`[server] === FINISHED JOB ${jobIndex + 1} (${jobCompleted}/${needed}) ===`);
      }

      // ALL JOBS COMPLETE
      sseEvent(res, "done", { completed, total: grandTotal });

      // ---- capture endBalance right before final logging ----
      try {
        await runDoginals(["wallet", "sync"], { walletLabel });
      } catch (_) {}
      endBalance = calcWalletBalanceDoge(readDoginalsWallet(walletLabel));

      // logging addition
      finalizeOnce(cancelled ? "cancelled" : "done", { completed });
      res.end();
    } catch (err) {
      sseEvent(res, "mintError", { message: err.message || String(err) });

      // ---- capture endBalance right before final logging (error path) ----
      try {
        await runDoginals(["wallet", "sync"], { walletLabel });
      } catch (_) {}
      endBalance = calcWalletBalanceDoge(readDoginalsWallet(walletLabel));

      finalizeOnce("error", { completed });
      res.end();
    } finally {
      if (cancelled) {
        // ---- capture endBalance right before final logging (cancel path) ----
        try {
          await runDoginals(["wallet", "sync"], { walletLabel });
        } catch (_) {}
        endBalance = calcWalletBalanceDoge(readDoginalsWallet(walletLabel));

        finalizeOnce("cancelled", { completed });
      }
    }

  })();
});



// POST /api/doginals/upload
// multipart/form-data with field "files"
app.post('/api/doginals/upload', doginalsUpload.array('files', 10000), (req, res) => {
  try {
    const uploaded = req.files || [];
    if (!uploaded.length) {
      return res.status(400).json({ ok: false, error: 'No files uploaded' });
    }

    // Only keep the files from THIS upload in DOGINALS_IMAGES_DIR
    const keep = new Set(uploaded.map((f) => f.filename));
    try {
      const existing = fs.readdirSync(DOGINALS_IMAGES_DIR);
      for (const name of existing) {
        if (!keep.has(name)) {
          fsExtra.removeSync(path.join(DOGINALS_IMAGES_DIR, name));
        }
      }
    } catch (e) {
      console.warn('Failed to clean old Doginals images:', e.message);
    }

    const feePerKb = getFeePerKb();

    const files = uploaded.map((f) => {
      const size = f.size;
      const mime = f.mimetype;
      const kb = Math.max(1, Math.ceil(size / 1024));
      const estFeeSats = kb * feePerKb;
      const estFeeDoge = estFeeSats / 1e8;

      return {
        name: f.filename,
        size,
        mime,
        estFeeSats,
        estFeeDoge,
      };
    });

    // Sort numerically by filename (00001, 00002, 00010, etc.)
    files.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    );

    res.json({
      ok: true,
      feePerKb,
      files,
    });
  } catch (err) {
    console.error('Error in /api/doginals/upload:', err);
    res.status(500).json({ ok: false, error: 'Upload failed', message: err.message });
  }
});

// POST /api/doginals/cleanup-images
// Clears the DOGINALS_IMAGES_DIR (used on clear/refresh)
app.post('/api/doginals/cleanup-images', async (req, res) => {
  try {
    if (!fs.existsSync(DOGINALS_IMAGES_DIR)) {
      return res.json({ ok: true, cleared: 0 });
    }

    const entries = fs.readdirSync(DOGINALS_IMAGES_DIR);
    for (const name of entries) {
      fsExtra.removeSync(path.join(DOGINALS_IMAGES_DIR, name));
    }

    res.json({ ok: true, cleared: entries.length });
  } catch (err) {
    console.error('Error in /api/doginals/cleanup-images:', err);
    res.status(500).json({
      ok: false,
      error: 'Cleanup failed',
      message: err.message,
    });
  }
});

// --- Delete single uploaded Doginals image ---
app.post("/api/doginals/delete-image", async (req, res) => {
  try {
    const { name } = req.body || {};

    if (!name || typeof name !== "string") {
      return res.status(400).json({ ok: false, error: "Missing file name" });
    }

    // prevent path traversal
    if (name.includes("/") || name.includes("\\") || name.includes("..")) {
      return res.status(400).json({ ok: false, error: "Invalid file name" });
    }

    const imagesDir = path.join(__dirname, "images");
    const filePath = path.join(imagesDir, name);

    // ensure file exists inside /images
    if (!filePath.startsWith(imagesDir)) {
      return res.status(400).json({ ok: false, error: "Invalid file path" });
    }

    await fs.promises.unlink(filePath);

    return res.json({ ok: true });
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return res.status(404).json({ ok: false, error: "File not found" });
    }

    console.error("delete-image error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err),
    });
  }
});

// === Doginals Mint Stream (DROP-IN REPLACEMENT BLOCK) ===
app.post("/api/doginals/mint-stream", async (req, res) => {
  const { label, walletName, recipientAddress } = req.body || {};
  const walletLabel = label || walletName;

  if (!walletLabel || !recipientAddress) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const walletPath = getDoginalsWalletPath(walletLabel);
  const folder = path.join(__dirname, "images");

  // --- persistent run output (written incrementally) ---
  const runIso = new Date().toISOString().replace(/[:.]/g, "-");
  const outName = `inscriptions_${walletLabel}_${runIso}.json`;
  const outPath = path.join(DOGINALS_JSON_DIR, outName);

  const runState = {
    label: walletLabel,
    recipientAddress,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running", // running | done | error
    startBalance: null,
    endBalance: null,
    totalFiles: 0,
    completed: 0,
    results: [], // { file, inscriptionId, mode, txid }
    error: null,
  };

  // Write an initial file right away (so it exists even if we crash early)
  try {
    atomicWriteJson(outPath, runState);
  } catch (e) {
    appendWalletLog(
      walletLabel,
      `WARNING: failed to create output json ${outName}\n${e.message || String(e)}`
    );
  }

  const persistRunState = () => {
    runState.completed = runState.results.length;
    try {
      atomicWriteJson(outPath, runState);
    } catch (e) {
      appendWalletLog(
        walletLabel,
        `WARNING: failed to update output json ${outName}\n${e.message || String(e)}`
      );
    }
  };

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  function send(obj) {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch (_) {}
  }

  const isMempoolChainErr = (txt) => {
    const t = String(txt || "");
    return (
      t.includes("too-long-mempool-chain") ||
      t.includes("64: too-long-mempool-chain")
    );
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // =========================================================
  // ✅ UPDATED WAIT LOGIC (wallet-scoped, 30s poll, no jumping)
  // =========================================================

  function readWalletAddressSafe() {
    try {
      const w = readDoginalsWallet(walletLabel);
      return w && w.address ? String(w.address) : null;
    } catch {
      return null;
    }
  }

  // Get the "wallet tip" txid that belongs to THIS minting wallet only.
  // We do this using listtransactions (wallet-scoped RPC) and filter by:
  //  - confirmations == 0
  //  - category == "send"
  //  - and matches THIS wallet by address (primary), or label (fallback)
  //
  // IMPORTANT:
  // - We do NOT look at global mempool.
  // - We do NOT use listunspent (can pick funding/change txs).
  // - This prevents waiting on other wallets / other activity.
  async function getWalletTipTxidFromListTransactions() {
    const addr = readWalletAddressSafe();

    try {
      const txs = await callDogecoinRpc("listtransactions", ["*", 500, 0, true]);
      if (!Array.isArray(txs) || !txs.length) return null;

      // pick newest matching send (based on tx.time/timereceived)
      let best = null;

      for (const tx of txs) {
        const txid = tx && tx.txid;
        if (!txid) continue;

        const conf = Number(tx.confirmations || 0);
        if (conf !== 0) continue;

        const cat = String(tx.category || "").toLowerCase();
        if (cat !== "send") continue;

        // HARD SCOPE: must match THIS wallet
        const txAddr = tx.address ? String(tx.address) : null;
        const txLabel = tx.label ? String(tx.label) : null;

        const matchesThisWallet =
          (addr && txAddr && txAddr === addr) ||
          (txLabel && walletLabel && txLabel === walletLabel);

        if (!matchesThisWallet) continue;

        const t = Number(tx.time || tx.timereceived || 0);
        if (!best || t > best.time) best = { txid, time: t };
      }

      return best ? best.txid : null;
    } catch (e) {
      send({
        type: "log",
        message: `[server] warning: listtransactions failed while trying to find wallet tip: ${
          e.message || String(e)
        }`,
      });
      return null;
    }
  }

  async function getConfirmations(txid) {
    if (!txid) return 0;
    try {
      const r = await callDogecoinRpc("getrawtransaction", [txid, true]);
      const c = Number(r && r.confirmations ? r.confirmations : 0);
      return Number.isFinite(c) ? c : 0;
    } catch (e) {
      return 0;
    }
  }

  // Wait for THIS WALLET’s selected tip to confirm.
  // IMPORTANT: We lock onto the chosen txid and do NOT "refresh" to other txids mid-wait.
  // (prevents jumping to other wallet activity)
  async function waitForWalletTipConfirmation30s(reasonLabel) {
    const tip = await getWalletTipTxidFromListTransactions();

    if (!tip) {
      send({
        type: "log",
        message: `[server] ${reasonLabel}: no unconfirmed wallet tip found for this wallet. Skipping wait.`,
      });
      return null;
    }

    send({
      type: "status",
      message: `${reasonLabel}: waiting for last broadcast tx to confirm: ${tip}`,
    });

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const conf = await getConfirmations(tip);
      if (conf >= 1) {
        send({
          type: "status",
          message: `${reasonLabel}: confirmed ${tip} (${conf} conf). Continuing...`,
        });
        return tip;
      }

      send({
        type: "log",
        message: `[server] waiting for confirmation (30s poll) ${tip}`,
      });

      await sleep(30_000);
    }
  }

  // =========================================================
  // ✅ NEW: resolve the *correct* inscription txid after mempool recovery
  // =========================================================
  //
  // Reliable method:
  //  - Take a tx that we KNOW is part of the mint (confirmed tip or walletSync printed tx)
  //  - Find its genesis txid via findGenesisTxid()
  //  - Find the reveal/inscription tx that spends genesisTxid in vin[]
  //  - That reveal txid is the correct inscription txid
  async function resolveInscriptionTxidAfterRecovery(baseTxid) {
    if (!baseTxid) return null;

    let genesisTxid = null;
    try {
      genesisTxid = await findGenesisTxid(baseTxid);
    } catch (_) {
      genesisTxid = null;
    }
    if (!genesisTxid) return null;

    let txs = null;
    try {
      txs = await callDogecoinRpc("listtransactions", ["*", 2000, 0, true]);
    } catch (_) {
      txs = null;
    }
    if (!Array.isArray(txs) || !txs.length) return null;

    // Deduplicate (listtransactions can include multiple rows per tx)
    const seen = new Set();
    const uniqueTxids = [];
    for (const t of txs) {
      const txid = t && t.txid;
      if (!txid) continue;
      if (seen.has(txid)) continue;
      seen.add(txid);
      uniqueTxids.push(txid);
    }

    // Scan wallet txs for a tx that spends genesisTxid in vin[]
    for (const txid of uniqueTxids) {
      try {
        const raw = await callDogecoinRpc("getrawtransaction", [txid, true]);
        const vin = (raw && raw.vin) || [];
        if (!Array.isArray(vin)) continue;

        if (vin.some((v) => v && v.txid === genesisTxid)) {
          return txid; // ✅ reveal/inscription txid
        }
      } catch (_) {
        // ignore
      }
    }

    return null;
  }

  // Runs wallet sync until it prints an inscription txid.
  // If wallet sync hits mempool-chain again, we wait on THIS wallet’s tip (again).
  //
  // ✅ FIX ADDED:
  // If wallet sync DOES NOT print inscription txid (the "balance spam" case),
  // we attempt to resolve the inscription txid from the node using the confirmedTipTxid.
  async function syncUntilInscriptionTxid(confirmedTipTxid) {
    const maxLoops = 50;
    for (let loop = 1; loop <= maxLoops; loop++) {
      let syncStdout = "";

      try {
        await runDoginals(["wallet", "sync"], {
          walletLabel,
          onStdoutChunk: (line) => {
            syncStdout += line;
            send({ type: "log", message: line.trimEnd() });
          },
          onStderrChunk: (line) => {
            send({ type: "log", message: `[stderr] ${line.trimEnd()}` });
          },
        });
      } catch (err) {
        const out =
          (err.stdout || "") + " " + (err.stderr || "") + " " + (err.message || "");

        if (!isMempoolChainErr(out)) throw err;

        await waitForWalletTipConfirmation30s("wallet sync mempool-chain");
        continue;
      }

      // 1) Best case: doginals printed the inscription txid
      const m = syncStdout.match(/inscription txid:\s*([0-9a-fA-F]{64})/);
      if (m) {
        return { txid: m[1], source: "printed" };
      }

      // 2) ✅ NEW: If nothing printed, try resolving from the node (wallet scoped) using confirmed tip
      if (confirmedTipTxid) {
        try {
          const resolved = await resolveInscriptionTxidAfterRecovery(confirmedTipTxid);
          if (resolved) {
            send({
              type: "status",
              message: `wallet sync did not print inscription txid — resolved from node: ${resolved}`,
            });
            return { txid: resolved, source: "resolved" };
          }
        } catch (_) {
          // ignore and keep looping
        }
      }

      send({
        type: "status",
        message: `wallet sync did not print inscription txid (loop ${loop}/${maxLoops}) — retrying after 30s...`,
      });
      await sleep(30_000);
    }

    // ✅ If still nothing, return null so caller can do a final resolve attempt / error cleanly
    return { txid: null, source: "none" };
  }

  // =========================================================

  try {
    const files = fs
      .readdirSync(folder)
      .filter((f) => !f.startsWith("."))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    runState.totalFiles = files.length;

    // Best effort: sync wallet first so startBalance reflects latest utxos
    try {
      await runDoginals(["wallet", "sync"], { walletLabel });
    } catch (_) {}
    const wStart = readDoginalsWallet(walletLabel);
    runState.startBalance = calcWalletBalanceDoge(wStart);
    persistRunState();

    send({ type: "status", message: `Found ${files.length} files.` });

    const minted = [];

    for (let i = 0; i < files.length; i++) {
      const filename = files[i];
      const fullPath = path.join(folder, filename);

      send({ type: "status", message: `Minting ${filename}` });
      send({ type: "progress", current: i + 1, total: files.length });

      let inscriptionTxid = null;
      let usedWalletSync = false;

      try {
        // --- Attempt normal mint ---
        await runDoginals(["mint", recipientAddress, fullPath], {
          walletLabel,
          onStdoutChunk: (line) => {
            if (line.includes("inscription txid:")) {
              const m = line.match(/([0-9a-fA-F]{64})/);
              if (m) inscriptionTxid = m[1];
            }
            send({ type: "log", message: line.trimEnd() });
          },
          onStderrChunk: (line) => {
            send({ type: "log", message: `[stderr] ${line.trimEnd()}` });
          },
        });

        if (!inscriptionTxid) {
          throw new Error("Mint finished without an inscription txid in stdout.");
        }

        // ✅ NORMAL PATH UNCHANGED:
        // If doginals prints the txid directly (no mempool wait), that's the inscription txid.
        const inscriptionId = `${inscriptionTxid}i0`;
        minted.push({ file: filename, inscriptionId });

        runState.results.push({
          file: filename,
          inscriptionId,
          mode: "normal",
          txid: inscriptionTxid,
        });
        persistRunState();

        send({
          type: "status",
          message: `Saved inscription ID (normal): ${inscriptionId}`,
        });
      } catch (err) {
        const out =
          (err.stdout || "") + " " + (err.stderr || "") + " " + (err.message || "");

        if (!isMempoolChainErr(out)) {
          send({
            type: "error",
            message: err.message || "Mint failed",
            stdout: err.stdout || "",
            stderr: err.stderr || "",
          });
          throw err;
        }

        // ✅ MEMPOOL-CHAIN PATH
        send({
          type: "status",
          message: "Mempool chain too long — switching to wait + wallet sync recovery...",
        });

        // ✅ Wait on THIS wallet’s last broadcast only (30s poll, no jumping)
        const confirmedTipTxid = await waitForWalletTipConfirmation30s("mint mempool-chain");

        // ✅ Now wallet sync (to continue the same file)
        usedWalletSync = true;

        // This may print txid OR may not (balance spam case)
        const syncResult = await syncUntilInscriptionTxid(confirmedTipTxid);

        send({
          type: "status",
          message: `wallet sync completed pending mint. txid: ${syncResult.txid || "none"}`,
        });

        // ✅ FINAL TXID SELECTION (ONLY FOR RECOVERY)
        // Priority:
        //  1) If sync already resolved a txid from node -> that's final
        //  2) If sync printed a txid -> resolve via genesis->reveal if possible, else use printed
        //  3) If sync printed nothing -> resolve from confirmed tip, else hard error
        let finalInscriptionTxid = null;

        if (syncResult && syncResult.txid && syncResult.source === "resolved") {
          finalInscriptionTxid = syncResult.txid;
        } else if (syncResult && syncResult.txid && syncResult.source === "printed") {
          const resolved = await resolveInscriptionTxidAfterRecovery(syncResult.txid);
          finalInscriptionTxid = resolved || syncResult.txid;
        } else {
          const resolved = await resolveInscriptionTxidAfterRecovery(confirmedTipTxid);
          if (!resolved) {
            throw new Error(
              "wallet sync did not print inscription txid and node resolution failed — cannot determine final inscription txid."
            );
          }
          finalInscriptionTxid = resolved;
        }

        const inscriptionId = `${finalInscriptionTxid}i0`;
        minted.push({ file: filename, inscriptionId });

        // ✅ Save ONLY the correct txid (no genesisTxid field, no extras)
        runState.results.push({
          file: filename,
          inscriptionId,
          mode: "mempool-recovery",
          txid: finalInscriptionTxid,
        });
        persistRunState();

        send({
          type: "status",
          message: `Saved inscription ID (recovery): ${inscriptionId}`,
        });
      }

      // Delete file after success (either path)
      try {
        fsExtra.removeSync(fullPath);
      } catch (e) {
        send({
          type: "log",
          message: `[server] warning: failed to remove file ${filename}: ${
            e.message || String(e)
          }`,
        });
      }

      // Optional cleanup: remove pending-txs.json after recovery completion
      if (usedWalletSync) {
        const pendingPath = path.join(path.dirname(walletPath), "pending-txs.json");
        if (fs.existsSync(pendingPath)) {
          try {
            fs.unlinkSync(pendingPath);
            send({
              type: "log",
              message: "[server] removed pending-txs.json after completion.",
            });
          } catch (_) {}
        }
      }
    }

    // Best effort: final sync + end balance
    try {
      await runDoginals(["wallet", "sync"], { walletLabel });
    } catch (_) {}
    const wEnd = readDoginalsWallet(walletLabel);
    runState.endBalance = calcWalletBalanceDoge(wEnd);

    runState.status = "done";
    runState.finishedAt = new Date().toISOString();
    persistRunState();

    appendWalletLog(
      walletLabel,
      [
        `DOGINALS FILE MINT COMPLETE`,
        `recipient=${recipientAddress}`,
        `filesTotal=${runState.totalFiles}`,
        `completed=${runState.completed}`,
        `startBalance=${runState.startBalance}`,
        `endBalance=${runState.endBalance}`,
        `outputJson=${outName}`,
      ].join("\n")
    );

    send({ type: "done", results: minted, outputJson: outName });
    res.end();
  } catch (err) {
    runState.status = "error";
    runState.finishedAt = new Date().toISOString();
    runState.error = {
      message: err && err.message ? err.message : String(err),
    };
    persistRunState();

    appendWalletLog(
      walletLabel,
      [
        `DOGINALS FILE MINT ERROR`,
        `recipient=${recipientAddress}`,
        `filesTotal=${runState.totalFiles}`,
        `completed=${runState.completed}`,
        `startBalance=${runState.startBalance}`,
        `endBalance=${runState.endBalance}`,
        `outputJson=${outName}`,
        `error=${runState.error.message}`,
      ].join("\n")
    );

    send({
      type: "error",
      message: err.message || "Mint stream failed",
      outputJson: outName,
    });
    res.end();
  }
});



const JSON_DIR = path.join(ROOT, "json");

// safe allow-list for filenames to prevent path traversal
function isSafeJsonFileName(name) {
  if (!name) return false;
  const s = String(name).trim();
  if (!s) return false;
  // forbid slashes/backslashes and dot-dot
  if (s.includes("/") || s.includes("\\") || s.includes("..")) return false;
  // require .json
  if (!s.toLowerCase().endsWith(".json")) return false;
  // basic filename charset
  if (!/^[a-zA-Z0-9._\- ]+\.json$/.test(s)) return false;
  return true;
}

// List JSON files in /json
app.get("/api/json-files", async (req, res) => {
  try {
    await fs.promises.mkdir(JSON_DIR, { recursive: true });

    const names = await fs.promises.readdir(JSON_DIR);
    const files = [];

    for (const name of names) {
      if (!name.toLowerCase().endsWith(".json")) continue;

      const full = path.join(JSON_DIR, name);
      let st;
      try {
        st = await fs.promises.stat(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;

      files.push({
        name,
        size: st.size,
        mtime: st.mtime ? st.mtime.toISOString() : null,
      });
    }

    // newest first
    files.sort((a, b) => {
      const ta = a.mtime ? Date.parse(a.mtime) : 0;
      const tb = b.mtime ? Date.parse(b.mtime) : 0;
      return tb - ta;
    });

    res.json({ ok: true, files });
  } catch (e) {
    console.error("GET /api/json-files error:", e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Fetch one JSON file from /json (parsed)
app.get("/api/json-files/:name", async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();

    if (!isSafeJsonFileName(name)) {
      return res.status(400).json({ ok: false, error: "Invalid file name." });
    }

    const full = path.join(JSON_DIR, name);

    // Ensure resolved path stays inside JSON_DIR
    const resolved = path.resolve(full);
    const base = path.resolve(JSON_DIR);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      return res.status(400).json({ ok: false, error: "Blocked path traversal." });
    }

    const raw = await fs.promises.readFile(full, "utf8");
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      return res.status(400).json({ ok: false, error: "Invalid JSON file: " + e.message });
    }

    // Optional: light validation so UI errors are clearer
    // (UI extracts results[].inscriptionId in order)
    if (!obj || typeof obj !== "object") {
      return res.status(400).json({ ok: false, error: "JSON root must be an object." });
    }

    res.json({
      ok: true,
      name,
      data: obj,
    });
  } catch (e) {
    console.error("GET /api/json-files/:name error:", e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Ensure dirs exist
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(SAVES_DIR, { recursive: true });

// IMPORTANT: you removed the size limit line — but you still need a JSON parser.
// This is required for POST /api/define/saves/:name
app.use(express.json());

// Serve uploads + saves statically (so URLs returned by API actually load)
app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/saves", express.static(SAVES_DIR));

// Helpers
function safeBaseName(input) {
  // strips path traversal and keeps only the filename portion
  return path.basename(String(input || ""));
}

function isAllowedImage(name) {
  return /\.(png|jpe?g|webp)$/i.test(name);
}

function isAllowedSave(name) {
  return /\.json$/i.test(name);
}

// Multer storage: keep original extension, make filename safe/unique
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const original = safeBaseName(file.originalname || "upload");
    const ext = path.extname(original).toLowerCase();
    const base = path.basename(original, ext).replace(/[^a-z0-9_\- ]+/gi, "_").trim() || "file";
    const stamp = Date.now();
    cb(null, `${base}-${stamp}${ext}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const original = safeBaseName(file.originalname || "");
    if (!isAllowedImage(original)) return cb(new Error("Only png/jpg/jpeg/webp allowed"));
    cb(null, true);
  },
});

// ---------- UPLOADS ----------

// Upload files into /uploads
app.post("/api/define/uploads", upload.array("files"), (req, res) => {
  try {
    const files = (req.files || []).map((f) => ({
      name: path.basename(f.filename),
      size: f.size,
      mtime: new Date().toISOString(),
      url: "/uploads/" + encodeURIComponent(path.basename(f.filename)),
    }));
    res.json({ ok: true, count: files.length, files });
  } catch (e) {
    console.error("define uploads POST error", e);
    res.status(500).json({ ok: false, error: "Upload failed." });
  }
});

// List files currently in /uploads
app.get("/api/define/uploads", async (req, res) => {
  try {
    const names = await fs.promises.readdir(UPLOADS_DIR);
    const files = [];

    for (const n of names) {
      const name = safeBaseName(n);
      if (!isAllowedImage(name)) continue;

      const full = path.join(UPLOADS_DIR, name);
      const st = await fs.promises.stat(full).catch(() => null);
      if (!st || !st.isFile()) continue;

      files.push({
        name,
        size: st.size,
        mtime: st.mtime.toISOString(),
        url: "/uploads/" + encodeURIComponent(name),
      });
    }

    // Natural-ish sort for 00001.png etc; stable
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

    res.json({ ok: true, files });
  } catch (e) {
    console.error("define uploads GET error", e);
    // IMPORTANT: if folder doesn't exist, return empty rather than failing
    if (e && (e.code === "ENOENT")) return res.json({ ok: true, files: [] });
    res.status(500).json({ ok: false, error: "Failed to list uploads." });
  }
});

// Delete all uploaded images (clear uploads folder)
app.delete("/api/define/uploads", async (req, res) => {
  try {
    const names = await fs.promises.readdir(UPLOADS_DIR).catch(() => []);
    let deleted = 0;

    for (const n of names) {
      const name = safeBaseName(n);
      if (!isAllowedImage(name)) continue;

      const full = path.join(UPLOADS_DIR, name);
      const st = await fs.promises.stat(full).catch(() => null);
      if (!st || !st.isFile()) continue;

      await fs.promises.unlink(full).catch(() => {});
      deleted++;
    }

    res.json({ ok: true, deleted });
  } catch (e) {
    console.error("define uploads DELETE(all) error", e);
    res.status(500).json({ ok: false, error: "Failed to clear uploads." });
  }
});

// Delete one uploaded image
app.delete("/api/define/uploads/:name", async (req, res) => {
  try {
    const name = safeBaseName(req.params.name);
    if (!isAllowedImage(name)) return res.status(400).json({ ok: false, error: "Invalid file type." });

    const full = path.join(UPLOADS_DIR, name);
    // Basic containment check (path.join + basename is already safe, but keep it)
    if (!full.startsWith(UPLOADS_DIR)) return res.status(400).json({ ok: false, error: "Bad path." });

    await fs.promises.unlink(full);
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ ok: false, error: "Not found." });
  }
});

// ---------- SAVES ----------

// List saves in /saves
app.get("/api/define/saves", async (req, res) => {
  try {
    const names = await fs.promises.readdir(SAVES_DIR).catch(() => []);
    const files = [];

    for (const n of names) {
      const name = safeBaseName(n);
      if (!isAllowedSave(name)) continue;

      const full = path.join(SAVES_DIR, name);
      const st = await fs.promises.stat(full).catch(() => null);
      if (!st || !st.isFile()) continue;

      files.push({
        name,
        size: st.size,
        mtime: st.mtime.toISOString(),
        url: "/saves/" + encodeURIComponent(name), // optional direct download
      });
    }

    files.sort((a, b) => b.mtime.localeCompare(a.mtime)); // newest first
    res.json({ ok: true, files });
  } catch (e) {
    console.error("define saves GET(list) error", e);
    res.status(500).json({ ok: false, error: "Failed to list saves." });
  }
});

// Read a save file
app.get("/api/define/saves/:name", async (req, res) => {
  try {
    const name = safeBaseName(req.params.name);
    if (!isAllowedSave(name)) return res.status(400).json({ ok: false, error: "Only .json allowed." });

    const full = path.join(SAVES_DIR, name);
    if (!full.startsWith(SAVES_DIR)) return res.status(400).json({ ok: false, error: "Bad path." });

    const raw = await fs.promises.readFile(full, "utf8");
    const data = JSON.parse(raw);

    res.json({ ok: true, name, data });
  } catch (e) {
    console.error("define saves GET(read) error", e);
    res.status(404).json({ ok: false, error: "Save not found or invalid JSON." });
  }
});

// Write/update a save file
app.post("/api/define/saves/:name", async (req, res) => {
  try {
    let name = safeBaseName(req.params.name);
    if (!name.toLowerCase().endsWith(".json")) name += ".json";
    if (!isAllowedSave(name)) return res.status(400).json({ ok: false, error: "Only .json allowed." });

    const full = path.join(SAVES_DIR, name);
    if (!full.startsWith(SAVES_DIR)) return res.status(400).json({ ok: false, error: "Bad path." });

    const payload = req.body;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ ok: false, error: "Invalid JSON payload." });
    }

    await fs.promises.writeFile(full, JSON.stringify(payload, null, 2), "utf8");
    res.json({ ok: true, name });
  } catch (e) {
    console.error("define saves POST(write) error", e);
    res.status(500).json({ ok: false, error: "Failed to write save file." });
  }
});

// Delete a save file
app.delete("/api/define/saves/:name", async (req, res) => {
  try {
    const name = safeBaseName(req.params.name);
    if (!isAllowedSave(name)) return res.status(400).json({ ok: false, error: "Only .json allowed." });

    const full = path.join(SAVES_DIR, name);
    if (!full.startsWith(SAVES_DIR)) return res.status(400).json({ ok: false, error: "Bad path." });

    await fs.promises.unlink(full);
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ ok: false, error: "Save not found." });
  }
});



app.listen(PORT, () => {
  console.log(`Doginal Viewer server listening on http://localhost:${PORT}`);
});
