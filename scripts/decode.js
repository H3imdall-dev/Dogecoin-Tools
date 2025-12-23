#!/usr/bin/env node
"use strict";

const axios = require("axios");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");

dotenv.config();

const NODE_RPC_URL = process.env.NODE_RPC_URL;
const NODE_RPC_USER = process.env.NODE_RPC_USER;
const NODE_RPC_PASS = process.env.NODE_RPC_PASS;

if (!NODE_RPC_URL || !NODE_RPC_USER || !NODE_RPC_PASS) {
  console.error(
    "ERROR: Please set NODE_RPC_URL, NODE_RPC_USER and NODE_RPC_PASS in .env for your local node."
  );
  if (require.main === module) {
    process.exit(1);
  }
}

const rpcClient =
  NODE_RPC_URL && NODE_RPC_USER && NODE_RPC_PASS
    ? axios.create({
        baseURL: NODE_RPC_URL,
        auth: {
          username: NODE_RPC_USER,
          password: NODE_RPC_PASS,
        },
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 30000,
      })
    : null;

async function rpc(method, params = [], id = "doginals-viewer") {
  if (!rpcClient) {
    throw new Error(
      "RPC client not initialised. Check NODE_RPC_URL / USER / PASS."
    );
  }
  const body = { jsonrpc: "2.0", id, method, params };
  try {
    const res = await rpcClient.post("", body);
    if (res.data.error) {
      const err = new Error(
        res.data.error.message || JSON.stringify(res.data.error)
      );
      err._method = method;
      err._params = params;
      err._raw = res.data.error;
      throw err;
    }
    return res.data.result;
  } catch (err) {
    if (err.code === "ECONNREFUSED") {
      console.error("ERROR: Cannot connect to local node at", NODE_RPC_URL);
      console.error(
        "Make sure your dogecoind node is running and RPC is enabled."
      );
    }
    throw err;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONTENT_DIR = path.join(process.cwd(), "content");
const MASTER_DIR = path.join(CONTENT_DIR, "master");
const MASTER_PATH = path.join(MASTER_DIR, "master.json");

function ensureContentDir() {
  if (!fs.existsSync(CONTENT_DIR)) {
    fs.mkdirSync(CONTENT_DIR, { recursive: true });
  }
  if (!fs.existsSync(MASTER_DIR)) {
    fs.mkdirSync(MASTER_DIR, { recursive: true });
  }
}

function loadMaster() {
  ensureContentDir();
  if (!fs.existsSync(MASTER_PATH)) return {};
  try {
    const raw = fs.readFileSync(MASTER_PATH, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (e) {
    console.warn("Invalid master.json, resetting:", e.message);
    return {};
  }
}

function saveMaster(master) {
  ensureContentDir();
  fs.writeFileSync(MASTER_PATH, JSON.stringify(master, null, 2), "utf8");
}

function upsertMasterEntry(meta) {
  if (!meta || !meta.inscriptionId) return;
  const master = loadMaster();
  const existing = master[meta.inscriptionId] || {};
  const createdAt =
    existing.createdAt || meta.createdAt || new Date().toISOString();
  master[meta.inscriptionId] = {
    ...existing,
    ...meta,
    createdAt,
  };
  saveMaster(master);
}

function findContentFile(idOrTxid) {
  if (!idOrTxid) return null;

  const base = idOrTxid.toLowerCase();
  const cleaned = base.replace(/i\d+$/, "");

  const candidates = [
    ...new Set(
      [base, cleaned, cleaned ? `${cleaned}i0` : null].filter(Boolean)
    ),
  ];

  try {
    ensureContentDir();
    const entries = fs.readdirSync(CONTENT_DIR);
    for (const name of entries) {
      const lower = name.toLowerCase();
      for (const cand of candidates) {
        if (!cand) continue;
        if (lower.startsWith(cand + ".")) {
          return path.join(CONTENT_DIR, name);
        }
      }
    }
  } catch (e) {
    console.warn("findContentFile error:", e.message);
  }

  return null;
}

/**
 * =========================
 * NEW: mime normalisation + file sniffing (for missing/incorrect ext)
 * =========================
 */

function normalizeMimeType(mimeType) {
  if (!mimeType) return "application/octet-stream";
  return (
    String(mimeType).split(";")[0].trim().toLowerCase() ||
    "application/octet-stream"
  );
}

function sniffFileTypeFromBuffer(buf) {
  try {
    if (!buf || !Buffer.isBuffer(buf) || buf.length < 4) {
      return { mimeType: null, ext: null };
    }

    // GLB magic "glTF"
    if (buf.toString("ascii", 0, 4) === "glTF") {
      return { mimeType: "model/gltf-binary", ext: "glb" };
    }

    // PNG
    if (
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    ) {
      return { mimeType: "image/png", ext: "png" };
    }

    // JPG
    if (
      buf.length >= 3 &&
      buf[0] === 0xff &&
      buf[1] === 0xd8 &&
      buf[2] === 0xff
    ) {
      return { mimeType: "image/jpeg", ext: "jpg" };
    }

    // GIF
    if (buf.length >= 6) {
      const gif = buf.toString("ascii", 0, 6);
      if (gif === "GIF87a" || gif === "GIF89a") {
        return { mimeType: "image/gif", ext: "gif" };
      }
    }

    // WEBP: RIFF....WEBP
    if (buf.length >= 12) {
      const riff = buf.toString("ascii", 0, 4);
      const webp = buf.toString("ascii", 8, 12);
      if (riff === "RIFF" && webp === "WEBP") {
        return { mimeType: "image/webp", ext: "webp" };
      }
    }

    // Very conservative GLTF JSON heuristic
    if (buf.length >= 32) {
      const head = buf.slice(0, 256).toString("utf8");
      const t = head.trimStart();
      if (
        t.startsWith("{") &&
        /"asset"\s*:\s*\{/.test(t) &&
        /"version"\s*:\s*"/.test(t)
      ) {
        return { mimeType: "model/gltf+json", ext: "gltf" };
      }
    }

    return { mimeType: null, ext: null };
  } catch {
    return { mimeType: null, ext: null };
  }
}

/**
 * =========================
 * NEW: model-viewer dependency handling for no-extension model sources
 * - When dependency is a model-viewer src and has weak ext/mime:
 *   save raw as no-ext first, then rename to .glb (no content modification).
 * - Also skips the odd-hex padding hack for these cases (to avoid corrupting GLB).
 * =========================
 */

function isWeakExtOrMime(ext, mimeType) {
  const mt = normalizeMimeType(mimeType);
  return !ext || ext === "bin" || mt === "application/octet-stream";
}

function looksLikeModelViewerSrcUri(uri) {
  if (!uri) return false;
  const s = String(uri).trim();
  // Matches:
  //  - /content/<txid> or /content/<txid>i0 etc
  //  - bare <txid> or <txid>i0
  return (
    /\/content\/[0-9a-f]{64}(?:i\d+)?/i.test(s) ||
    /\b[0-9a-f]{64}(?:i\d+)?\b/i.test(s)
  );
}

function extractModelViewerSrcDependenciesFromHtml(text) {
  const deps = new Set();
  if (!text) return deps;

  // Find <model-viewer ... src="..."> or src='...'
  const tagRe = /<model-viewer\b[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(text)) !== null) {
    const tag = m[0];

    // src attribute
    const srcRe = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i;
    const sm = srcRe.exec(tag);
    if (!sm) continue;

    const rawSrc = (sm[1] || sm[2] || sm[3] || "").trim();
    if (!looksLikeModelViewerSrcUri(rawSrc)) continue;

    // Extract txid(/iN) from src
    const idMatch =
      /\/content\/([0-9a-f]{64}(?:i\d+)?)\b/i.exec(rawSrc) ||
      /\b([0-9a-f]{64}(?:i\d+)?)\b/i.exec(rawSrc);

    if (!idMatch) continue;

    let id = idMatch[1].toLowerCase();
    if (!/i\d+$/.test(id)) id = `${id}i0`;
    deps.add(id);
  }

  return deps;
}

function saveModelViewerNoExtThenGlb(inscriptionId, baseTxid, buf) {
  ensureContentDir();

  const rawOutPath = path.join(CONTENT_DIR, inscriptionId); // no extension
  const glbOutPath = path.join(CONTENT_DIR, `${inscriptionId}.glb`);

  // Write raw bytes exactly
  fs.writeFileSync(rawOutPath, buf);

  // Rename to .glb (or overwrite .glb if exists)
  try {
    if (fs.existsSync(glbOutPath)) {
      try {
        fs.unlinkSync(glbOutPath);
      } catch {}
    }
    fs.renameSync(rawOutPath, glbOutPath);
  } catch {
    // If rename fails (e.g. cross-device), fall back to copy+delete
    try {
      fs.writeFileSync(glbOutPath, buf);
      try {
        fs.unlinkSync(rawOutPath);
      } catch {}
    } catch {
      // ignore - if both fail, caller will blow up later on stat/read
    }
  }

  const fileStats = fs.statSync(glbOutPath);

  upsertMasterEntry({
    inscriptionId,
    txid: baseTxid,
    filename: path.basename(glbOutPath),
    mimeType: "model/gltf-binary",
    ext: "glb",
    size: fileStats.size,
  });

  return {
    outPath: glbOutPath,
    filename: path.basename(glbOutPath),
    mimeType: "model/gltf-binary",
    ext: "glb",
    size: fileStats.size,
  };
}

function maybeRenameFileToSniffedType(
  outPath,
  inscriptionId,
  currentMime,
  currentExt
) {
  const mt = normalizeMimeType(currentMime);
  const weak = !currentExt || currentExt === "bin" || mt === "application/octet-stream";

  if (!weak) return { outPath, mimeType: mt, ext: currentExt };

  let buf;
  try {
    buf = fs.readFileSync(outPath);
  } catch {
    return { outPath, mimeType: mt, ext: currentExt };
  }

  const sniff = sniffFileTypeFromBuffer(buf);
  if (!sniff.ext) return { outPath, mimeType: mt, ext: currentExt };

  const newExt = sniff.ext;
  const newMime = sniff.mimeType || mt;
  const newName = `${inscriptionId}.${newExt}`;
  const newPath = path.join(CONTENT_DIR, newName);

  try {
    if (path.resolve(newPath) !== path.resolve(outPath)) {
      if (fs.existsSync(newPath)) {
        // Avoid clobbering; keep existing newPath, remove old.
        try {
          fs.unlinkSync(outPath);
        } catch {}
        return { outPath: newPath, mimeType: newMime, ext: newExt };
      }
      fs.renameSync(outPath, newPath);
      return { outPath: newPath, mimeType: newMime, ext: newExt };
    }
  } catch {
    // If rename fails, still return sniffed metadata (we'll upsert master)
    return { outPath, mimeType: newMime, ext: newExt };
  }

  return { outPath, mimeType: newMime, ext: newExt };
}

/**
 * =========================
 * NEW: dependency scanning (HTML/SVG + JS/CSS/JSON/etc)
 * - still called handleHtmlSvgDependencies to avoid breaking server.js
 * - strict GLTF JSON handling: parse JSON and only inspect known URI fields
 * - model-viewer: track src dependencies so we can apply special save rule
 * =========================
 */

function isTextLikeMime(mimeType) {
  const mt = normalizeMimeType(mimeType);
  if (mt.startsWith("text/")) return true;
  if (mt === "image/svg+xml") return true;
  if (mt === "application/javascript") return true;
  if (mt === "application/x-javascript") return true;
  if (mt === "application/json") return true;
  if (mt === "application/xml") return true;
  if (mt === "model/gltf+json") return true; // special-case handled
  return false;
}

function extractDepsFromText(text) {
  const deps = new Set();
  if (!text) return deps;

  // /content/<txid>iN
  let m;
  const re1 = /\/content\/([0-9a-f]{64}i\d+)/gi;
  while ((m = re1.exec(text)) !== null) deps.add(m[1].toLowerCase());

  // /content/<txid>  (normalize to i0)
  const re2 = /\/content\/([0-9a-f]{64})(?![0-9a-f])/gi;
  while ((m = re2.exec(text)) !== null) deps.add(m[1].toLowerCase() + "i0");

  // bare <txid>iN (helps inline code that omits /content/)
  const re3 = /\b([0-9a-f]{64}i\d+)\b/gi;
  while ((m = re3.exec(text)) !== null) deps.add(m[1].toLowerCase());

  return deps;
}

function extractDepsFromGltfJson(buffer) {
  const deps = new Set();
  if (!buffer || !Buffer.isBuffer(buffer)) return deps;

  let gltf;
  try {
    gltf = JSON.parse(buffer.toString("utf8"));
  } catch {
    // If it's not valid JSON, don't scan (prevents false positives like "aaaa...i0")
    return deps;
  }

  const uris = [];

  // Only look where GLTF spec puts external references
  try {
    if (Array.isArray(gltf.buffers)) {
      for (const b of gltf.buffers)
        if (b && typeof b.uri === "string") uris.push(b.uri);
    }
    if (Array.isArray(gltf.images)) {
      for (const img of gltf.images)
        if (img && typeof img.uri === "string") uris.push(img.uri);
    }
  } catch {
    // ignore
  }

  for (const u of uris) {
    const found = extractDepsFromText(String(u));
    for (const id of found) deps.add(id);
  }

  return deps;
}

// Track model-viewer src dependencies (so ensureInscriptionDecoded can apply special rule)
const modelViewerSrcSet = new Set();

async function handleHtmlSvgDependencies(
  inscriptionId,
  mimeType,
  buffer,
  visited = new Set(),
  options = {}
) {
  // IMPORTANT: keep original name/signature for server.js compatibility
  const mt = normalizeMimeType(mimeType);

  // Only scan text-like content (HTML/SVG + JS/CSS/JSON etc)
  if (!isTextLikeMime(mt)) return;

  const baseTxid = inscriptionId.replace(/i\d+$/, "");
  if (visited.has(baseTxid)) return;
  visited.add(baseTxid);

  let deps = new Set();

  try {
    if (!buffer) {
      const filePath = findContentFile(inscriptionId);
      if (!filePath) {
        console.warn(
          "Cannot scan dependencies, file missing for",
          inscriptionId
        );
        return;
      }
      buffer = fs.readFileSync(filePath);
    }

    // Strict rule: GLTF JSON is parsed; no regex scanning over the whole file
    if (mt === "model/gltf+json") {
      deps = extractDepsFromGltfJson(buffer);
    } else {
      // Normal text scanning
      const text = buffer.toString("utf8");
      deps = extractDepsFromText(text);

      // NEW: detect model-viewer src deps for special GLB saving
      const mv = extractModelViewerSrcDependenciesFromHtml(text);
      for (const id of mv) modelViewerSrcSet.add(id);
    }
  } catch (e) {
    console.warn("Could not scan as text for dependency scan:", e.message);
    return;
  }

  if (deps.size === 0) {
    console.log("No recursive inscription references found in text content.");
    return;
  }

  console.log(
    `↺ Detected content dependencies in ${inscriptionId} (${mimeType}):`
  );
  for (const id of deps) console.log("  -", id);

  const { progressKey, onProgress } = options;
  if (progressKey) setDependencyPlan(progressKey, deps.size, onProgress);

  for (const depId of deps) {
    const child = await ensureInscriptionDecoded(depId, {
      progressKey,
      onProgress,
    });

    // Recurse only into text-like types
    if (isTextLikeMime(child.mimeType)) {
      await handleHtmlSvgDependencies(
        child.inscriptionId,
        child.mimeType,
        child.resultBuf,
        visited,
        options
      );
    }

    if (progressKey) incrementDependencyDone(progressKey, onProgress);
  }
}

/**
 * =========================
 * Progress tracking (unchanged)
 * =========================
 */

const progressMap = new Map();

function baseProgressObject(key) {
  return {
    txid: key,
    chunksFound: 0,
    estimatedTotal: null,
    active: true,
    label: "init",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    depTotal: null,
    depDone: 0,
  };
}

function initProgress(key) {
  progressMap.set(key, baseProgressObject(key));
}

function snapshotFromProgress(key, p) {
  const total = p.estimatedTotal || p.chunksFound;
  const remaining = total - p.chunksFound;
  const depRemaining =
    typeof p.depTotal === "number"
      ? Math.max(0, p.depTotal - (p.depDone || 0))
      : null;

  return {
    txid: key,
    label: p.label,
    chunksFound: p.chunksFound,
    estimatedTotal: p.estimatedTotal,
    remaining,
    active: p.active,
    startedAt: p.startedAt,
    updatedAt: p.updatedAt,
    depTotal: p.depTotal,
    depDone: p.depDone,
    depRemaining,
  };
}

function updateProgress(key, label, chunksFoundInStep, numChunksReported, cb) {
  const p = progressMap.get(key) || baseProgressObject(key);

  if (chunksFoundInStep > 0) {
    p.chunksFound += chunksFoundInStep;
  }

  if (typeof numChunksReported === "number" && !Number.isNaN(numChunksReported)) {
    const candidateTotal = p.chunksFound + numChunksReported;
    if (!p.estimatedTotal || candidateTotal > p.estimatedTotal) {
      p.estimatedTotal = candidateTotal;
    }
  }

  p.label = label;
  p.active = true;
  p.updatedAt = new Date().toISOString();

  progressMap.set(key, p);

  const snapshot = snapshotFromProgress(key, p);

  if (typeof cb === "function") {
    cb(snapshot);
  }

  console.log(
    `[progress][${key}] ${label}: chunks ${snapshot.chunksFound}/${
      snapshot.estimatedTotal || "?"
    }`
  );
}

function setDependencyPlan(key, totalDeps, cb) {
  if (!key || !Number.isFinite(totalDeps) || totalDeps <= 0) return;
  const p = progressMap.get(key) || baseProgressObject(key);
  p.depTotal = totalDeps;
  p.depDone = 0;
  p.updatedAt = new Date().toISOString();
  progressMap.set(key, p);

  const snapshot = snapshotFromProgress(key, p);
  if (typeof cb === "function") cb(snapshot);
}

function incrementDependencyDone(key, cb) {
  if (!key) return;
  const p = progressMap.get(key);
  if (!p) return;
  if (typeof p.depDone !== "number") p.depDone = 0;
  p.depDone += 1;
  p.updatedAt = new Date().toISOString();
  progressMap.set(key, p);

  const snapshot = snapshotFromProgress(key, p);
  if (typeof cb === "function") cb(snapshot);

  console.log(
    `[progress][${key}] deps: ${snapshot.depDone}/${snapshot.depTotal ?? "?"}`
  );
}

function completeProgress(key, cb) {
  const p = progressMap.get(key);
  if (!p) return;
  p.active = false;
  p.updatedAt = new Date().toISOString();
  progressMap.set(key, p);

  const snapshot = snapshotFromProgress(key, p);

  if (typeof cb === "function") {
    cb(snapshot);
  }
}

function resetProgressForId(key) {
  progressMap.delete(key);
}

function getProgress(key) {
  const p = progressMap.get(key);
  if (!p) return null;
  return snapshotFromProgress(key, p);
}

function isIntegerString(s) {
  return /^-?\d+$/.test(s);
}

function hexToAscii(hexString) {
  try {
    return Buffer.from(hexString, "hex").toString("utf8");
  } catch (e) {
    console.warn("Error converting hex to ASCII:", e.message);
    return null;
  }
}

function processGenesisAsm(asmData) {
  console.log("🐾 processGenesisAsm called");
  if (asmData.length < 3) {
    throw new Error("Genesis asm too short.");
  }

  let numChunks = parseInt(asmData[1].replace(/^-/, ""), 10);
  const mimeTypeHex = asmData[2];
  const mimeType = hexToAscii(mimeTypeHex) || "application/octet-stream";

  console.log(`  ↳ num_chunks (initial): ${numChunks}`);
  console.log(`  ↳ mime_type: ${mimeType}`);

  let dataHex = "";
  let index = 3;
  let chunksFound = 0;
  let lastNumChunks = numChunks;

  while (index < asmData.length) {
    const token = asmData[index];
    if (isIntegerString(token)) {
      numChunks = parseInt(token.replace(/^-/, ""), 10);
      const dataChunk = asmData[index + 1];
      if (typeof dataChunk !== "string") break;

      dataHex += dataChunk;
      chunksFound++;
      lastNumChunks = numChunks;

      console.log(
        `  • genesis chunk #${chunksFound}: num_chunks=${numChunks}, hexLen=${dataChunk.length}`
      );

      index += 2;
      if (numChunks === 0) {
        return {
          dataHex,
          mimeType,
          endOfData: true,
          chunksFound,
          lastNumChunks,
        };
      }
    } else {
      break;
    }
  }

  return { dataHex, mimeType, endOfData: false, chunksFound, lastNumChunks };
}

function processSubsequentAsm(asmData) {
  console.log("🐾 processSubsequentAsm called");
  let dataHex = "";
  let index = 0;
  let chunksFound = 0;
  let lastNumChunks = null;
  let numChunks;

  while (index < asmData.length) {
    const token = asmData[index];
    if (isIntegerString(token)) {
      numChunks = parseInt(token.replace(/^-/, ""), 10);
      const dataChunk = asmData[index + 1];
      if (typeof dataChunk !== "string") break;

      dataHex += dataChunk;
      chunksFound++;
      lastNumChunks = numChunks;

      console.log(
        `  • subsequent chunk #${chunksFound}: num_chunks=${numChunks}, hexLen=${dataChunk.length}`
      );

      index += 2;
      if (numChunks === 0) {
        return { dataHex, endOfData: true, chunksFound, lastNumChunks };
      }
    } else {
      break;
    }
  }

  return { dataHex, endOfData: false, chunksFound, lastNumChunks };
}

async function findNextOrdinalTx(txid, voutIndex, depthBlocks = 1000) {
  console.log(
    `🔭 findNextOrdinalTx called with txid=${txid}, vout_index=${voutIndex}, depth=${depthBlocks}`
  );

  let rawTx;
  try {
    rawTx = await rpc("getrawtransaction", [txid, 1]);
  } catch (e) {
    console.warn(
      "getrawtransaction failed while searching for next ordinal tx:",
      e.message
    );
    return null;
  }

  if (!rawTx.blockhash) {
    console.warn(
      "Transaction has no blockhash (mempool or orphan); cannot walk chain."
    );
    return null;
  }

  const blockHash = rawTx.blockhash;
  const block = await rpc("getblock", [blockHash]);
  const startHeight = block.height;

  console.log(`  ↳ start block height: ${startHeight}`);

  for (
    let currentHeight = startHeight;
    currentHeight <= startHeight + depthBlocks;
    currentHeight++
  ) {
    let hash;
    try {
      hash = await rpc("getblockhash", [currentHeight]);
    } catch {
      console.log(
        `  ↳ reached tip or invalid height at ${currentHeight}, stopping search.`
      );
      return null;
    }

    const blk = await rpc("getblock", [hash, 2]);
    console.log(`  • scanning block ${currentHeight} (${blk.tx.length} txs)`);

    for (const blockTx of blk.tx) {
      for (const vin of blockTx.vin || []) {
        if (vin.txid === txid && vin.vout === voutIndex) {
          console.log(
            `    ➜ Found next ordinal TX: ${blockTx.txid} in block height ${currentHeight}`
          );
          return {
            nextTxid: blockTx.txid,
            voutIndex: vin.vout ?? 0,
            height: currentHeight,
          };
        }
      }
    }

    if ((currentHeight - startHeight) % 100 === 0) {
      await sleep(200);
    }
  }

  console.log("  ↳ No next ordinal transaction found within depth.");
  return null;
}

async function decodeDoginalsChain(genesisTxid, depthBlocks = 5000, options = {}) {
  const { progressKey = genesisTxid, onProgress, maxHops = 20000 } = options;

  console.log(
    `⛏ Starting Doginals decode for ${genesisTxid} (blockDepth ${depthBlocks}, maxHops ${maxHops}) [progressKey=${progressKey}]`
  );

  if (!getProgress(progressKey)) {
    resetProgressForId(progressKey);
    initProgress(progressKey);
  }

  let dataHex = "";
  let mimeType = null;
  let isGenesis = true;
  let txid = genesisTxid;
  const processedTxids = new Set();
  let voutIndex = 0;
  let endOfData = false;
  let hop = 0;

  while (!endOfData && hop < maxHops) {
    hop++;

    if (processedTxids.has(txid)) {
      console.log(
        `↺ Detected loop at txid ${txid}, attempting to find next ordinal tx…`
      );
      const next = await findNextOrdinalTx(txid, voutIndex, depthBlocks);
      if (next) {
        txid = next.nextTxid;
        voutIndex = next.voutIndex;
        continue;
      } else {
        console.log("End of chain reached, no further ordinals found (loop).");
        break;
      }
    }
    processedTxids.add(txid);

    const rawTx = await rpc("getrawtransaction", [txid, 1]);
    console.log(`🔎 Processing TX ${txid} (hop ${hop})`);

    for (const vin of rawTx.vin || []) {
      if (!vin.scriptSig || !vin.scriptSig.asm) continue;

      const asmData = String(vin.scriptSig.asm).trim().split(/\s+/);
      if (!asmData.length) continue;

      if (isGenesis) {
        if (asmData[0] === "6582895") {
          const {
            dataHex: part,
            mimeType: mt,
            endOfData: eod,
            chunksFound,
            lastNumChunks,
          } = processGenesisAsm(asmData);

          dataHex += part;
          mimeType = mt;
          endOfData = eod;
          isGenesis = false;

          updateProgress(progressKey, "genesis", chunksFound, lastNumChunks, onProgress);
        } else {
          continue;
        }
      } else {
        const { dataHex: part, endOfData: eod, chunksFound, lastNumChunks } =
          processSubsequentAsm(asmData);

        if (part) dataHex += part;
        endOfData = endOfData || eod;

        if (chunksFound) {
          updateProgress(progressKey, "chain", chunksFound, lastNumChunks, onProgress);
        }
      }
    }

    if (endOfData) {
      console.log("✅ num_chunks == 0 signalled end of data.");
      break;
    }

    const next = await findNextOrdinalTx(txid, voutIndex, depthBlocks);
    if (next) {
      txid = next.nextTxid;
      voutIndex = next.voutIndex;
    } else {
      console.log("End of chain reached, no further ordinals found.");
      break;
    }
  }

  if (hop >= maxHops && !endOfData) {
    console.warn(
      `⚠ Reached maxHops (${maxHops}) without seeing num_chunks == 0; inscription may be truncated.`
    );
  }

  if (!dataHex.length) {
    completeProgress(progressKey, onProgress);
    throw new Error("No Doginals data found in transaction chain.");
  }

  if (!mimeType) {
    console.warn("MIME type is unknown, defaulting to application/octet-stream.");
    mimeType = "application/octet-stream";
  }

  const stats = getProgress(progressKey) || {
    chunksFound: 0,
    estimatedTotal: null,
  };

  console.log(
    `🏁 Doginals decode finished. Chunks found=${stats.chunksFound}` +
      (stats.estimatedTotal ? `, estimated total≈${stats.estimatedTotal}` : "")
  );

  completeProgress(progressKey, onProgress);

  return { dataHex, mimeType, stats };
}

async function reconstructAndReturnBuffer(baseTxid, options = {}) {
  const { progressKey = baseTxid, onProgress, skipOddHexPad = false } = options;
  const { dataHex: originalHex, mimeType: rawMimeType, stats } =
    await decodeDoginalsChain(baseTxid, 5000, { progressKey, onProgress });

  let dataHex = originalHex;

  if (!skipOddHexPad && dataHex.length % 2 !== 0) {
    console.warn(
      `Warning: Data hex length is odd (${dataHex.length}), padding 5 zeros (Python-compatible hack).`
    );
    dataHex += "00000";
  }

  ensureContentDir();

  // IMPORTANT: normalize mime before extension lookup (fixes "text/html; charset=utf-8")
  let mimeType = normalizeMimeType(rawMimeType);
  let ext = mime.extension(mimeType) || "bin";

  const inscriptionId = `${baseTxid}i0`;
  let filename = `${inscriptionId}.${ext}`;
  let outPath = path.join(CONTENT_DIR, filename);

  const resultBuf = Buffer.from(dataHex, "hex");
  fs.writeFileSync(outPath, resultBuf);

  // NEW: if we got a weak ext/mime, sniff and rename (fixes missing .glb deps)
  const renamed = maybeRenameFileToSniffedType(outPath, inscriptionId, mimeType, ext);
  outPath = renamed.outPath;
  mimeType = renamed.mimeType || mimeType;
  ext = renamed.ext || ext;
  filename = path.basename(outPath);

  const fileStats = fs.statSync(outPath);

  console.log(`✔ Saved inscription → content/${filename}`);
  console.log(`   Size: ${fileStats.size} bytes`);
  console.log(
    `   Chunks: ${stats.chunksFound}` +
      (stats.estimatedTotal ? ` / ~${stats.estimatedTotal}` : "")
  );

  upsertMasterEntry({
    inscriptionId,
    txid: baseTxid,
    filename,
    mimeType,
    ext,
    size: fileStats.size,
  });

  console.log(
    JSON.stringify(
      {
        inscriptionId,
        filename,
        mimeType,
        size: fileStats.size,
        chunksFound: stats.chunksFound,
        estimatedTotalChunks: stats.estimatedTotal,
      },
      null,
      2
    )
  );

  return { resultBuf, mimeType, inscriptionId };
}

async function ensureInscriptionDecoded(idOrTxid, options = {}) {
  ensureContentDir();
  const master = loadMaster();

  const clean = idOrTxid.trim();
  const hasSuffix = /i\d+$/.test(clean);
  const inscriptionId = hasSuffix ? clean : `${clean.replace(/i\d+$/, "")}i0`;
  const baseTxid = inscriptionId.replace(/i\d+$/, "");

  const masterEntry = master[inscriptionId];

  if (masterEntry) {
    const candidate = masterEntry.filename
      ? path.join(CONTENT_DIR, masterEntry.filename)
      : findContentFile(inscriptionId);

    if (candidate && fs.existsSync(candidate)) {
      console.log(`Master: using existing inscription ${inscriptionId}`);

      const fileExt = path.extname(candidate).slice(1).toLowerCase();
      let mimeType =
        normalizeMimeType(masterEntry.mimeType) ||
        normalizeMimeType(mime.lookup(fileExt)) ||
        "application/octet-stream";

      // NEW: if cached file is actually a GLB (or other), fix metadata once
      if (
        fileExt === "bin" ||
        mimeType === "application/octet-stream" ||
        !masterEntry.ext ||
        masterEntry.ext === "bin"
      ) {
        try {
          const buf = fs.readFileSync(candidate);
          const sniff = sniffFileTypeFromBuffer(buf);
          if (sniff.ext || sniff.mimeType) {
            const fixedExt = sniff.ext || fileExt || masterEntry.ext || "bin";
            const fixedMime = sniff.mimeType || mimeType;
            const stats = fs.statSync(candidate);
            upsertMasterEntry({
              inscriptionId,
              txid: baseTxid,
              filename: path.basename(candidate),
              mimeType: fixedMime,
              ext: fixedExt,
              size: stats.size,
            });
            mimeType = fixedMime;
          }
        } catch {
          // ignore
        }
      }

      return {
        resultBuf: null,
        mimeType,
        inscriptionId,
        fromCache: true,
      };
    }

    console.log(
      `Master entry found for ${inscriptionId} but file missing, reconstructing...`
    );
  } else {
    const existingFile = findContentFile(inscriptionId);
    if (existingFile) {
      const fileExt = path.extname(existingFile).slice(1).toLowerCase();
      let mimeType =
        normalizeMimeType(mime.lookup(fileExt)) || "application/octet-stream";

      // NEW: if unknown, sniff and register
      if (fileExt === "bin" || mimeType === "application/octet-stream") {
        try {
          const buf = fs.readFileSync(existingFile);
          const sniff = sniffFileTypeFromBuffer(buf);
          if (sniff.mimeType) mimeType = sniff.mimeType;
          const stats = fs.statSync(existingFile);
          upsertMasterEntry({
            inscriptionId,
            txid: baseTxid,
            filename: path.basename(existingFile),
            mimeType,
            ext: sniff.ext || fileExt || "bin",
            size: stats.size,
          });
        } catch {
          const stats = fs.statSync(existingFile);
          upsertMasterEntry({
            inscriptionId,
            txid: baseTxid,
            filename: path.basename(existingFile),
            mimeType,
            ext: fileExt || "bin",
            size: stats.size,
          });
        }

        console.log(`Master: registered existing file for ${inscriptionId}`);
        return {
          resultBuf: null,
          mimeType,
          inscriptionId,
          fromCache: true,
        };
      }

      const stats = fs.statSync(existingFile);
      upsertMasterEntry({
        inscriptionId,
        txid: baseTxid,
        filename: path.basename(existingFile),
        mimeType,
        ext: fileExt || "bin",
        size: stats.size,
      });
      console.log(`Master: registered existing file for ${inscriptionId}`);
      return {
        resultBuf: null,
        mimeType,
        inscriptionId,
        fromCache: true,
      };
    }
  }

  // NEW: if this id is a model-viewer src dependency, enforce "raw no-ext then .glb"
  const isModelViewerSrc = modelViewerSrcSet.has(inscriptionId.toLowerCase());

  const { resultBuf, mimeType, inscriptionId: realId } =
    await reconstructAndReturnBuffer(baseTxid, {
      progressKey: options.progressKey || baseTxid,
      onProgress: options.onProgress,
      // critical: avoid padding hack on model-viewer model sources
      skipOddHexPad: isModelViewerSrc,
    });

  if (isModelViewerSrc) {
    // If it decoded to weak ext/mime (or anything without glb), force save like your manual method.
    const mt = normalizeMimeType(mimeType);
    const ext = mime.extension(mt) || "bin";

    if (isWeakExtOrMime(ext, mt)) {
      try {
        const saved = saveModelViewerNoExtThenGlb(realId, baseTxid, resultBuf);
        console.log(
          `✔ Model-viewer dependency saved as ${saved.filename} (raw preserved)`
        );
      } catch (e) {
        console.warn(
          "Model-viewer dependency special save failed, falling back:",
          e.message
        );
      }
    }
  }

  return {
    resultBuf,
    mimeType,
    inscriptionId: realId,
    fromCache: false,
  };
}

async function reconstruct(inputTxidOrInscription) {
  const base = inputTxidOrInscription.trim();
  const baseTxid = base.replace(/i\d+$/, "");
  const progressKey = baseTxid;

  // Clear model-viewer tracking per top-level run (prevents cross-run bleed)
  modelViewerSrcSet.clear();

  const { resultBuf, mimeType, inscriptionId } = await ensureInscriptionDecoded(
    base,
    {
      progressKey,
      onProgress: () => {},
    }
  );

  // KEEP ORIGINAL BEHAVIOUR: only auto-recurse for HTML/SVG (server expects this),
  // but our handleHtmlSvgDependencies now ALSO scans JS/CSS/JSON *when those are dependencies*.
  if (
    mimeType === "text/html" ||
    mimeType === "image/svg+xml" ||
    (mimeType || "").toLowerCase().includes("html") ||
    (mimeType || "").toLowerCase().includes("svg")
  ) {
    await handleHtmlSvgDependencies(inscriptionId, mimeType, resultBuf, undefined, {
      progressKey,
      onProgress: () => {},
    });
  }
}

if (require.main === module) {
  const [, , txidArg] = process.argv;
  if (!txidArg) {
    console.error("Usage: node scripts/decode.js <txid or txid+i0>");
    process.exit(1);
  }

  reconstruct(txidArg)
    .then(() => {
      console.log("Done.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("ERROR:", err.message);
      if (err._method) {
        console.error("RPC", err._method, err._params, err._raw);
      }
      process.exit(1);
    });
}

module.exports = {
  ensureInscriptionDecoded,
  decodeDoginalsChain,
  reconstructAndReturnBuffer,
  handleHtmlSvgDependencies, // IMPORTANT: keep export name so server.js doesn't break
  getProgress,
  resetProgressForId,
  CONTENT_DIR,
  MASTER_PATH,
  findContentFile,
};
