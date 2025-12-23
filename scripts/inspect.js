#!/usr/bin/env node

// inspect.js (Dogecoin)
//
// Usage: node inspect.js <txid>
//
// For the given txid:
//  - fetches decoded tx via local dogecoind (same RPC style as decode.js)
//  - prints vin[0].scriptSig (hex + ASM + chunk breakdown)
//  - looks up the prevout for vin[0]
//  - if prevout is P2SH, tries to:
//      * extract redeemScript from last pushed data in scriptSig
//      * decode redeemScript (asm + hex)
//      * verify HASH160(redeemScript) matches scriptPubKey

const axios = require("axios");
const dotenv = require("dotenv");
const dogecore = require("bitcore-lib-doge");

dotenv.config();

const { Script } = dogecore;
const { Hash } = dogecore.crypto;

// ---------------- RPC CONFIG (local Dogecoin node) ----------------

const NODE_RPC_URL  = process.env.NODE_RPC_URL;
const NODE_RPC_USER = process.env.NODE_RPC_USER;
const NODE_RPC_PASS = process.env.NODE_RPC_PASS;

if (!NODE_RPC_URL || !NODE_RPC_USER || !NODE_RPC_PASS) {
  console.error("ERROR: Please set NODE_RPC_URL, NODE_RPC_USER and NODE_RPC_PASS in .env for your local Dogecoin node.");
  process.exit(1);
}

const rpcClient = axios.create({
  baseURL: NODE_RPC_URL,
  auth: {
    username: NODE_RPC_USER,
    password: NODE_RPC_PASS,
  },
  headers: {
    "Content-Type": "application/json",
  },
  timeout: 30000,
});

async function rpc(method, params = [], id = "inspect-doge") {
  const body = { jsonrpc: "2.0", id, method, params };

  try {
    const res = await rpcClient.post("", body);

    if (res.data && res.data.error) {
      const err = new Error(res.data.error.message || JSON.stringify(res.data.error));
      err._method = method;
      err._params = params;
      err._raw = res.data.error;
      throw err;
    }
    return res.data.result;
  } catch (err) {
    if (err.response) {
      console.error("RPC HTTP error:", err.response.status, err.response.statusText);
      console.error("RPC body:", JSON.stringify(err.response.data, null, 2));
    } else {
      console.error("RPC error:", err.message);
    }
    if (err.code === "ECONNREFUSED") {
      console.error("ERROR: Cannot connect to local node at", NODE_RPC_URL);
      console.error("Make sure your dogecoind node is running and RPC is enabled.");
    }
    throw err;
  }
}

// ---------------- HELPERS ----------------

function dumpScriptChunks(label, scriptHex) {
  console.log(`\n=== ${label} ===`);
  console.log("hex :", scriptHex);

  let script;
  try {
    script = Script.fromHex(scriptHex);
  } catch (e) {
    console.log("Could not parse as Script:", e.message);
    return null;
  }

  console.log("asm :", script.toASM());

  console.log("chunks:");
  script.chunks.forEach((ch, idx) => {
    if (ch.buf) {
      console.log(
        `  [${idx}] PUSH (len=${ch.buf.length}) op=${ch.opcodenum} hex=${ch.buf.toString("hex")}`
      );
    } else {
      console.log(`  [${idx}] OP   op=${ch.opcodenum}`);
    }
  });

  return script;
}

function hash160(buf) {
  return Hash.ripemd160(Hash.sha256(buf));
}

// ---------------- CORE INSPECT ----------------

async function inspectTx(txid) {
  const tx = await rpc("getrawtransaction", [txid, true]);

  console.log("TXID:", tx.txid);
  console.log("Version:", tx.version, "Locktime:", tx.locktime);
  console.log("Inputs:", tx.vin.length, "Outputs:", tx.vout.length);

  const vin0 = tx.vin[0];
  if (!vin0) {
    console.log("No inputs in this transaction.");
    return;
  }

  if (!vin0.scriptSig || !vin0.scriptSig.hex) {
    console.log("vin[0] has no scriptSig.");
    return;
  }

  // --- Dump scriptSig of vin[0] ---
  const scriptSigHex = vin0.scriptSig.hex;
  const scriptSig = dumpScriptChunks("vin[0].scriptSig", scriptSigHex);

  // --- Look up prevout ---
  console.log("\n=== Prevout (vin[0]) ===");
  console.log("Prev txid:", vin0.txid, "vout:", vin0.vout);

  const prev = await rpc("getrawtransaction", [vin0.txid, true]);
  const prevOut = prev.vout[vin0.vout];

  if (!prevOut) {
    console.log("Could not find prevout.");
    return;
  }

  console.log("Prevout value:", prevOut.value, "DOGE");
  console.log("Prevout scriptPubKey.type:", prevOut.scriptPubKey.type);
  console.log("Prevout scriptPubKey.hex :", prevOut.scriptPubKey.hex);
  console.log("Prevout scriptPubKey.asm :", prevOut.scriptPubKey.asm);

  if (prevOut.scriptPubKey.type !== "scripthash") {
    console.log("\nPrevout is NOT P2SH (type != scripthash).");
    return;
  }

  // --- Try to extract redeemScript from last pushed data in scriptSig ---

  if (!scriptSig) {
    console.log("\nCannot decode scriptSig; aborting redeemScript extraction.");
    return;
  }

  const dataChunks = scriptSig.chunks.filter((ch) => ch && ch.buf);
  if (!dataChunks.length) {
    console.log("\nNo data pushes in scriptSig; cannot extract redeemScript.");
    return;
  }

  const redeemBuf = dataChunks[dataChunks.length - 1].buf;

  console.log("\n=== Guessed redeemScript (last pushed data in scriptSig) ===");

  let redeem;
  try {
    redeem = Script.fromBuffer(redeemBuf);
  } catch (e) {
    console.log("Could not parse redeemScript from last push:", e.message);
    console.log("raw redeem buf hex:", redeemBuf.toString("hex"));
    return;
  }

  console.log("redeemScript hex:", redeem.toHex());
  console.log("redeemScript asm:", redeem.toASM());

  // Verify HASH160(redeemScript) matches P2SH scriptPubKey
  const redeemHash = hash160(redeemBuf).toString("hex");
  console.log("redeemScript HASH160:", redeemHash);

  const spkHex = prevOut.scriptPubKey.hex;
  // P2SH standard: a914{20-byte-hash}87
  let scriptHashHex = null;
  if (spkHex.startsWith("a914") && spkHex.endsWith("87") && spkHex.length === 46) {
    scriptHashHex = spkHex.slice(4, 44);
  }

  console.log("scriptPubKey HASH160:", scriptHashHex);

  if (scriptHashHex === redeemHash) {
    console.log("✔ redeemScript hash MATCHES scriptPubKey hash160");
  } else {
    console.log("✖ redeemScript hash DOES NOT MATCH scriptPubKey hash160");
  }
}

// ---------------- CLI ----------------

const [, , txid] = process.argv;
if (!txid) {
  console.error("Usage: node inspect.js <txid>");
  process.exit(1);
}

inspectTx(txid).catch((err) => {
  console.error("ERROR:", err.message);
  if (err._method) {
    console.error("RPC", err._method, err._params, err._raw);
  }
});
