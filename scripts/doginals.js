#!/usr/bin/env node

'use strict';

const path = require('path');
const dogecore = require('bitcore-lib-doge');
const axios = require('axios');
const fs = require('fs');
const dotenv = require('dotenv');
const mime = require('mime-types');
const express = require('express'); // kept for compatibility, even if not used directly here.

const { PrivateKey, Address, Transaction, Script, Opcode } = dogecore;
const { Hash, Signature } = dogecore.crypto;

// --------------------------------------------------------------------------
// ENV + PATHS
// --------------------------------------------------------------------------

// Force dotenv to read .env from project root (one level above scripts/)
const ROOT_DIR = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(__dirname, '.env') });

if (process.env.TESTNET === 'true') {
  dogecore.Networks.defaultNetwork = dogecore.Networks.testnet;
}

// Fee per KB in *sats* (DOGE base units). Default: 1 DOGE/kB (100_000_000 sats)
if (process.env.FEE_PER_KB) {
  Transaction.FEE_PER_KB = parseInt(process.env.FEE_PER_KB, 10);
} else {
  Transaction.FEE_PER_KB = 100000000;
}

// For CLI usage you can still override WALLET via env,
// but we resolve it relative to the project root by default.
const WALLET_PATH =
  process.env.WALLET ||
  path.join(ROOT_DIR, '.wallet.json');
 // Directory that contains .wallet.json – used for per-wallet pending-txs.json
const WALLET_DIR = path.dirname(WALLET_PATH);
const PENDING_TXS_PATH = path.join(WALLET_DIR, 'pending-txs.json');
 

// --------------------------------------------------------------------------
// CLI ENTRY
// --------------------------------------------------------------------------

  async function main() {
    const cmd = process.argv[2];
  
    // On start, see if there are pending txs to re-broadcast
    // NOTE: per-wallet pending file lives next to .wallet.json
    const pendingPath = PENDING_TXS_PATH;
    if (fs.existsSync(pendingPath)) {
      console.log('found pending-txs.json. rebroadcasting...');
      const txs = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
      await broadcastAll(txs.map((tx) => new Transaction(tx)), false);
      return;
    }
  

  if (cmd === 'mint') {
    await mint();
  } else if (cmd === 'wallet') {
    await wallet();
  } else if (cmd === 'server') {
    await server(); // if you still use this entry
  } else if (cmd === 'drc-20') {
    await doge20();
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
}

// --------------------------------------------------------------------------
// DRC-20 HELPERS (deploy / mint / transfer)
// --------------------------------------------------------------------------

async function doge20() {
  const subcmd = process.argv[3];

  if (subcmd === 'mint') {
    await doge20Transfer('mint');
  } else if (subcmd === 'transfer') {
    await doge20Transfer('transfer');
  } else if (subcmd === 'deploy') {
    await doge20Deploy();
  } else {
    throw new Error(`unknown subcommand: ${subcmd}`);
  }
}

async function doge20Deploy() {
  const argAddress = process.argv[4];
  const argTicker = process.argv[5];
  const argMax = process.argv[6];
  const argLimit = process.argv[7];

  const doge20Tx = {
    p: 'drc-20',
    op: 'deploy',
    tick: `${(argTicker || '').toLowerCase()}`,
    max: `${argMax}`,
    lim: `${argLimit}`,
  };

  const parsed = JSON.stringify(doge20Tx);
  const encoded = Buffer.from(parsed).toString('hex');

  console.log('Deploying drc-20 token...');
  const result = await mint(argAddress, 'text/plain;charset=utf-8', encoded);
  return result;
}

async function doge20Transfer(op = 'transfer') {
  const argAddress = process.argv[4];
  const argTicker = process.argv[5];
  const argAmount = process.argv[6];
  const argRepeat = Number(process.argv[7]) || 1;

  const doge20Tx = {
    p: 'drc-20',
    op,
    tick: `${(argTicker || '').toLowerCase()}`,
    amt: `${argAmount}`,
  };

  const parsed = JSON.stringify(doge20Tx);
  const encoded = Buffer.from(parsed).toString('hex');

  for (let i = 0; i < argRepeat; i++) {
    console.log(
      `Minting drc-20 token... ${i + 1} of ${argRepeat} times`
    );
    await mint(argAddress, 'text/plain;charset=utf-8', encoded);
  }
}

// --------------------------------------------------------------------------
// WALLET SUBCOMMANDS
// --------------------------------------------------------------------------

async function wallet() {
  const subcmd = process.argv[3];

  if (subcmd === 'new') {
    walletNew();
  } else if (subcmd === 'sync') {
    await walletSync();
  } else if (subcmd === 'balance') {
    walletBalance();
  } else if (subcmd === 'send') {
    await walletSend();
  } else if (subcmd === 'split') {
    await walletSplit();
  } else {
    throw new Error(`unknown subcommand: ${subcmd}`);
  }
}

function walletNew() {
  if (!fs.existsSync(WALLET_PATH)) {
    const privateKey = new PrivateKey();
    const privkey = privateKey.toWIF();
    const address = privateKey.toAddress().toString();
    const json = { privkey, address, utxos: [] };
    fs.writeFileSync(WALLET_PATH, JSON.stringify(json, null, 2));
    console.log('address', address);
  } else {
    throw new Error('wallet already exists');
  }
}

async function walletSync() {
  if (!fs.existsSync(WALLET_PATH)) {
    throw new Error('wallet file not found');
  }

  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));

  console.log('syncing utxos with local Dogecoin node via RPC');

  const body = {
    jsonrpc: '1.0',
    id: 'walletsync',
    method: 'listunspent',
    params: [0, 9999999, [wallet.address]],
  };

  const options = {
    auth: {
      username: process.env.NODE_RPC_USER,
      password: process.env.NODE_RPC_PASS,
    },
  };

  const response = await axios.post(process.env.NODE_RPC_URL, body, options);
  const utxos = response.data.result || [];

  wallet.utxos = utxos.map((utxo) => ({
    txid: utxo.txid,
    vout: utxo.vout,
    script: utxo.scriptPubKey,
    satoshis: Math.round(utxo.amount * 1e8),
  }));

  fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, null, 2));

  const balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0);
  console.log('balance', balance);
}

function walletBalance() {
  if (!fs.existsSync(WALLET_PATH)) {
    throw new Error('wallet file not found');
  }

  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
  const balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0);
  console.log(wallet.address, balance);
}

async function walletSend() {
  const argAddress = process.argv[4];
  const argAmount = process.argv[5];

  if (!fs.existsSync(WALLET_PATH)) {
    throw new Error('wallet file not found');
  }

  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));

  const balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0);
  if (balance === 0) throw new Error('no funds to send');

  const receiver = new Address(argAddress);
  const amount = parseInt(argAmount, 10);

  let tx = new Transaction();
  if (amount) {
    tx.to(receiver, amount);
    fund(wallet, tx);
  } else {
    tx.from(wallet.utxos);
    tx.change(receiver);
    tx.sign(wallet.privkey);
  }

  await broadcast(tx, true);
  console.log(tx.hash);
}

async function walletSplit() {
  const splits = parseInt(process.argv[4], 10);
  if (!Number.isFinite(splits) || splits < 2) {
    throw new Error('invalid split count');
  }

  if (!fs.existsSync(WALLET_PATH)) {
    throw new Error('wallet file not found');
  }

  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
  const balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0);
  if (balance === 0) throw new Error('no funds to split');

  const tx = new Transaction();
  tx.from(wallet.utxos);
  for (let i = 0; i < splits - 1; i++) {
    tx.to(wallet.address, Math.floor(balance / splits));
  }
  tx.change(wallet.address);
  tx.sign(wallet.privkey);

  await broadcast(tx, true);
  console.log(tx.hash);
}

// --------------------------------------------------------------------------
// ORDINAl / DOGINAL MINTING
// --------------------------------------------------------------------------

const MAX_SCRIPT_ELEMENT_SIZE = 520;
const MAX_CHUNK_LEN = 240;
const MAX_PAYLOAD_LEN = 1500;

/**
 * CLI-style mint:
 * - paramAddress: destination address
 * - paramContentTypeOrFilename: MIME type *or* path to file
 * - paramHexData: hex string if not using file
 *
 * For server usage you can call:
 *   await mint(address, contentType, hexData);
 * Or:
 *   await mint(address, filePath); // will auto-detect MIME and read file
 */
async function mint(paramAddress, paramContentTypeOrFilename, paramHexData) {
  const argAddress = paramAddress || process.argv[3];
  const argContentTypeOrFilename = paramContentTypeOrFilename || process.argv[4];
  const argHexData = paramHexData || process.argv[5];

  const address = new Address(argAddress);
  let contentType;
  let data;

  if (fs.existsSync(argContentTypeOrFilename)) {
    const guess = mime.lookup(argContentTypeOrFilename) || 'application/octet-stream';
    contentType = mime.contentType(guess);
    data = fs.readFileSync(argContentTypeOrFilename);
  } else {
    contentType = argContentTypeOrFilename;
    if (!/^[a-fA-F0-9]*$/.test(argHexData || '')) {
      throw new Error('data must be hex');
    }
    data = Buffer.from(argHexData, 'hex');
  }

  if (!data || data.length === 0) {
    throw new Error('no data to mint');
  }

  if (contentType.length > MAX_SCRIPT_ELEMENT_SIZE) {
    throw new Error('content type too long');
  }

  if (!fs.existsSync(WALLET_PATH)) {
    throw new Error('wallet file not found');
  }
  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));

  const txs = inscribe(wallet, address, contentType, data);
  const result = await broadcastAll(txs, false);
  return result;
}

function bufferToChunk(b, type) {
  const buf = Buffer.from(b, type);
  return {
    buf: buf.length ? buf : undefined,
    len: buf.length,
    opcodenum: buf.length <= 75 ? buf.length : buf.length <= 255 ? 76 : 77,
  };
}

function numberToChunk(n) {
  return {
    buf:
      n <= 16
        ? undefined
        : n < 128
        ? Buffer.from([n])
        : Buffer.from([n % 256, Math.floor(n / 256)]),
    len: n <= 16 ? 0 : n < 128 ? 1 : 2,
    opcodenum: n === 0 ? 0 : n <= 16 ? 80 + n : n < 128 ? 1 : 2,
  };
}

function opcodeToChunk(op) {
  return { opcodenum: op };
}

function inscribe(wallet, address, contentType, data) {
  const txs = [];

  const privateKey = new PrivateKey(wallet.privkey);
  const publicKey = privateKey.toPublicKey();

  const parts = [];
  while (data.length) {
    const part = data.slice(0, Math.min(MAX_CHUNK_LEN, data.length));
    data = data.slice(part.length);
    parts.push(part);
  }

  const inscription = new Script();
  inscription.chunks.push(bufferToChunk('ord'));
  inscription.chunks.push(numberToChunk(parts.length));
  inscription.chunks.push(bufferToChunk(contentType));
  parts.forEach((part, n) => {
    inscription.chunks.push(numberToChunk(parts.length - n - 1));
    inscription.chunks.push(bufferToChunk(part));
  });

  let p2shInput;
  let lastLock;
  let lastPartial;

  while (inscription.chunks.length) {
    const partial = new Script();

    if (txs.length === 0) {
      partial.chunks.push(inscription.chunks.shift());
    }

    while (partial.toBuffer().length <= MAX_PAYLOAD_LEN && inscription.chunks.length) {
      partial.chunks.push(inscription.chunks.shift());
      partial.chunks.push(inscription.chunks.shift());
    }

    if (partial.toBuffer().length > MAX_PAYLOAD_LEN) {
      inscription.chunks.unshift(partial.chunks.pop());
      inscription.chunks.unshift(partial.chunks.pop());
    }

    const lock = new Script();
    lock.chunks.push(bufferToChunk(publicKey.toBuffer()));
    lock.chunks.push(opcodeToChunk(Opcode.OP_CHECKSIGVERIFY));
    partial.chunks.forEach(() => {
      lock.chunks.push(opcodeToChunk(Opcode.OP_DROP));
    });
    lock.chunks.push(opcodeToChunk(Opcode.OP_TRUE));

    const lockhash = Hash.ripemd160(Hash.sha256(lock.toBuffer()));

    const p2sh = new Script();
    p2sh.chunks.push(opcodeToChunk(Opcode.OP_HASH160));
    p2sh.chunks.push(bufferToChunk(lockhash));
    p2sh.chunks.push(opcodeToChunk(Opcode.OP_EQUAL));

    const p2shOutput = new Transaction.Output({
      script: p2sh,
      satoshis: 100000,
    });

    const tx = new Transaction();
    if (p2shInput) tx.addInput(p2shInput);
    tx.addOutput(p2shOutput);
    fund(wallet, tx);

    if (p2shInput) {
      const signature = Transaction.sighash.sign(
        tx,
        privateKey,
        Signature.SIGHASH_ALL,
        0,
        lastLock
      );
      const txsignature = Buffer.concat([
        signature.toBuffer(),
        Buffer.from([Signature.SIGHASH_ALL]),
      ]);

      const unlock = new Script();
      unlock.chunks = unlock.chunks.concat(lastPartial.chunks);
      unlock.chunks.push(bufferToChunk(txsignature));
      unlock.chunks.push(bufferToChunk(lastLock.toBuffer()));
      tx.inputs[0].setScript(unlock);
    }

    updateWallet(wallet, tx);
    txs.push(tx);

    p2shInput = new Transaction.Input({
      prevTxId: tx.hash,
      outputIndex: 0,
      output: tx.outputs[0],
      script: '',
    });

    p2shInput.clearSignatures = () => {};
    p2shInput.getSignatures = () => {};

    lastLock = lock;
    lastPartial = partial;
  }

  const tx = new Transaction();
  tx.addInput(p2shInput);
  tx.to(address, 100000);
  fund(wallet, tx);

  const signature = Transaction.sighash.sign(
    tx,
    privateKey,
    Signature.SIGHASH_ALL,
    0,
    lastLock
  );
  const txsignature = Buffer.concat([
    signature.toBuffer(),
    Buffer.from([Signature.SIGHASH_ALL]),
  ]);

  const unlock = new Script();
  unlock.chunks = unlock.chunks.concat(lastPartial.chunks);
  unlock.chunks.push(bufferToChunk(txsignature));
  unlock.chunks.push(bufferToChunk(lastLock.toBuffer()));
  tx.inputs[0].setScript(unlock);

  updateWallet(wallet, tx);
  txs.push(tx);

  return txs;
}

// --------------------------------------------------------------------------
// FUND / WALLET BOOK-KEEPING / BROADCAST
// --------------------------------------------------------------------------

function fund(wallet, tx) {
  tx.change(wallet.address);
  delete tx._fee;

  for (const utxo of wallet.utxos) {
    if (
      tx.inputs.length &&
      tx.outputs.length &&
      tx.inputAmount >= tx.outputAmount + tx.getFee()
    ) {
      break;
    }

    delete tx._fee;
    tx.from(utxo);
    tx.change(wallet.address);
    tx.sign(wallet.privkey);
  }

  if (tx.inputAmount < tx.outputAmount + tx.getFee()) {
    throw new Error('not enough funds');
  }
}

function updateWallet(wallet, tx) {
  // Remove spent UTXOs
  wallet.utxos = wallet.utxos.filter((utxo) => {
    for (const input of tx.inputs) {
      if (
        input.prevTxId.toString('hex') === utxo.txid &&
        input.outputIndex === utxo.vout
      ) {
        return false;
      }
    }
    return true;
  });

  // Add change / outputs back to our address
  tx.outputs.forEach((output, vout) => {
    const addr = output.script.toAddress();
    if (addr && addr.toString() === wallet.address) {
      wallet.utxos.push({
        txid: tx.hash,
        vout,
        script: output.script.toHex(),
        satoshis: output.satoshis,
      });
    }
  });

  fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, null, 2));
}

async function broadcastAll(txs, retry) {
    // Per-wallet pending file, lives next to .wallet.json
    const pendingPath = PENDING_TXS_PATH;
  
  for (let i = 0; i < txs.length; i++) {
    console.log(`broadcasting tx ${i + 1} of ${txs.length}`);

    try {
      await broadcast(txs[i], retry);
    } catch (e) {
      console.log('broadcast failed', e?.response?.data || e.message);
      const msg =
        e?.response?.data?.error?.message ||
        e?.message ||
        '';

      if (
        msg.includes('bad-txns-inputs-spent') ||
        msg.includes('already in block chain')
      ) {
        console.log('tx already sent, skipping');
        continue;
      }

      console.log('saving pending txs to pending-txs.json');
      console.log('to reattempt broadcast, re-run the command');
      fs.writeFileSync(
        pendingPath,
        JSON.stringify(
          txs.slice(i).map((tx) => tx.toString()),
          null,
          2
        )
      );
      process.exit(1);
    }
  }

  try {
    fs.unlinkSync(pendingPath);
  } catch (_) {
    // ignore
  }

  if (txs.length > 1) {
    console.log('inscription txid:', txs[1].hash);
  }

  return {
    txids: txs.map((t) => t.hash),
    inscriptionTxid: txs.length > 1 ? txs[1].hash : txs[0]?.hash,
  };
}

async function broadcast(tx, retry) {
  const body = {
    jsonrpc: '1.0',
    id: 0,
    method: 'sendrawtransaction',
    params: [tx.toString()],
  };

  const options = {
    auth: {
      username: process.env.NODE_RPC_USER,
      password: process.env.NODE_RPC_PASS,
    },
  };

  // Simple retry loop for too-long-mempool-chain
  // (exposed via CLI; the higher-level bulk-logic will live in the server).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await axios.post(process.env.NODE_RPC_URL, body, options);
      break;
    } catch (e) {
      if (!retry) throw e;
      const msg =
        e?.response?.data?.error?.message ||
        e?.message ||
        '';
      if (msg.includes('too-long-mempool-chain')) {
        console.warn('retrying, too-long-mempool-chain');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } else {
        throw e;
      }
    }
  }

  if (!fs.existsSync(WALLET_PATH)) return;
  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
  updateWallet(wallet, tx);
}

// --------------------------------------------------------------------------
// EXTRACT (read doginal content back out of a tx)
// --------------------------------------------------------------------------

function chunkToNumber(chunk) {
  if (chunk.opcodenum === 0) return 0;
  if (chunk.opcodenum === 1) return chunk.buf[0];
  if (chunk.opcodenum === 2) return chunk.buf[1] * 255 + chunk.buf[0];
  if (chunk.opcodenum > 80 && chunk.opcodenum <= 96) return chunk.opcodenum - 80;
  return undefined;
}

async function extract(txid) {
  const body = {
    jsonrpc: '1.0',
    id: 'extract',
    method: 'getrawtransaction',
    params: [txid, true],
  };

  const options = {
    auth: {
      username: process.env.NODE_RPC_USER,
      password: process.env.NODE_RPC_PASS,
    },
  };

  let response = await axios.post(process.env.NODE_RPC_URL, body, options);
  let transaction = response.data.result;

  let inputs = transaction.vin;
  let scriptHex = inputs[0].scriptSig.hex;
  let script = Script.fromHex(scriptHex);
  let chunks = script.chunks;

  let prefix = chunks.shift().buf.toString('utf-8');
  if (prefix !== 'ord') {
    throw new Error('not a doginal');
  }

  let pieces = chunkToNumber(chunks.shift());
  const contentType = chunks.shift().buf.toString('utf-8');

  let data = Buffer.alloc(0);
  let remaining = pieces;

  while (remaining && chunks.length) {
    const n = chunkToNumber(chunks.shift());
    if (n !== remaining - 1) {
      // follow to next transaction if necessary
      txid = transaction.vout[0].spent.hash;
      response = await axios.post(process.env.NODE_RPC_URL, body, options);
      transaction = response.data.result;
      inputs = transaction.vin;
      scriptHex = inputs[0].scriptSig.hex;
      script = Script.fromHex(scriptHex);
      chunks = script.chunks;
      continue;
    }

    data = Buffer.concat([data, chunks.shift().buf]);
    remaining -= 1;
  }

  return { contentType, data };
}

// --------------------------------------------------------------------------
// EXPORTS FOR SERVER.JS
// --------------------------------------------------------------------------

module.exports = {
  // low-level building blocks
  mint,
  walletNew,
  walletSync,
  walletBalance,
  walletSend,
  walletSplit,
  doge20Deploy,
  doge20Transfer,
  extract,
  broadcastAll,
  broadcast,
};

// --------------------------------------------------------------------------
// ONLY RUN MAIN() WHEN EXECUTED DIRECTLY VIA CLI
// --------------------------------------------------------------------------

if (require.main === module) {
  main().catch((e) => {
    const reason =
      e?.response?.data?.error?.message ||
      e.message ||
      'Unknown error';
    console.error(reason ? `${e.message}:${reason}` : e.message);
    process.exit(1);
  });
}
