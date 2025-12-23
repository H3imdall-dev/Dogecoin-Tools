<!-- =========================
    Dogecoin Node & Doginals Tooling — README
     ========================= -->

<div align="center">

<img src="assets/logo.png" alt="Doginals Tooling Logo" width="140" />

# Doginals Tooling
### Local-first node companion for Dogecoin + Doginals

Run this alongside your Dogecoin node to:
decode Doginal data, explore decoded content, manage wallet UTXOs, inscribe files, build metadata, and more.

<br/>

<!-- Replace these links with your real profiles -->
<a href="https://github.com/H3imdall-dev">
  <img alt="GitHub" src="https://img.shields.io/badge/GitHub-H3imdall--dev-181717?logo=github&logoColor=white" />
</a>
<a href="https://x.com/Heimdall_Bull">
  <img alt="X" src="https://img.shields.io/badge/X-Follow-000000?logo=x&logoColor=white" />
</a>
<br/><br/>

**Tips appreciated:** `DEpFirPqu8DZUoCT7zEzGZs74JPTCF3ZMJ`

</div>

---

## What this is
**Doginals Tooling** is a browser-based toolbox that runs locally (Node.js + Express) and connects to your **Dogecoin Core node** over RPC.

It helps node operators and creators:
- keep wallets clean (UTXO management + sending)
- decode and inspect Doginal transactions
- browse decoded Doginal content stored locally
- inscribe files onto the Dogecoin blockchain
- deploy and mint DRC-20 tokens
- generate metadata for collections (basic + advanced)
- convert HashLips metadata to Doginals format
- define traits from pixel fingerprints and auto-generate full trait metadata

---

## Prerequisites

### 1) Dogecoin Core node (required)
You need a Dogecoin node configured with RPC enabled and:

- `txindex=1`

If you don’t have a node set up yet, follow one of the tutorials here:
- https://github.com/H3imdall-dev/dogenodesetup - linux
- https://github.com/H3imdall-dev/WindowsDogeNodeSetup - windows
- https://github.com/H3imdall-dev/MacDogeNodeSetup - mac
- https://github.com/H3imdall-dev/dogenodevpsedition - vps edition (linux)

**Important:**
- Make sure your node is fully synced
- Keep the node up to date
- Ensure RPC username/password are set in `dogecoin.conf`

### 2) Node.js (required)
Install a modern Node.js version (LTS recommended).

---

## Install & Run

### 1) Install dependencies
Open the project folder in VS Code → Terminal:

```bash
npm install
```

### 2) add RPC Username and password details to .env now for ease

### 3) Start the server
```bash
npm start
```

### 3) Open the app
Visit:

```txt
http://localhost:3000
```

---

## First-time setup (RPC) - if you didnt do it earlier .. If you did skip this your app should be fully active 
1. Open **Node Tools**
2. Enter the RPC username + password from your `dogecoin.conf`
3. Click **Save**
4. Ctrl + c in vs code to shut down the server then restart it with 

```bash
npm start
```
5. Refresh the page - your node should be now active in the viewer

After this, the app should operate with full functionality.

---

## Pages

### Doginal Viewer
Decode any transaction and detect whether it contains Doginal data.
- inspect decoded payloads
- examine raw transaction information
- decode the txid in the info at the top to get heimdalls on chain website and all the tools locally - it will take about 15 mins or so to decode all the onc chain dependencies 

### Explorer
Browse decoded Doginal content from your local directory.
Anything decoded through the **Doginal Viewer** becomes available here for:
- filtered viewing
- quick navigation and inspection

### Node Tools
Wallet + node companion tools:
- UTXO-based sending (including choosing specific UTXOs)
- create new wallets
- import wallets into your node
- view details for sent transactions

### CLI Tools
Quick-click utilities that return raw JSON from your node.
Useful for:
- debugging / inspection
- verifying node responses without leaving the UI

### Inscribe
Full inscription suite:
- drag & drop files
- select wallet and inscribe
- inscription IDs returned after completion
- IDs can be imported into metadata tools automatically

Also includes **DRC-20 deploy + mint** workflows.

### Metadata
Create metadata files for collections:

**Basic**
- create `Collection Name #Number`
- import inscription IDs from the inscriber

**Advanced**
- advanced metadata with trait data
- import inscription IDs from the inscriber

**HashLips → Doginals format**
- upload a HashLips `_metadata.json`
- auto-convert to Doginals format (keeps names + attributes)
- import inscription IDs from the inscriber

### Define Traits
Pixel-fingerprint trait definition + auto generation:
- load collection images
- define trait layers using unique pixels
- auto-generate full collection trait metadata JSON
- combine later with inscription IDs via Metadata tools

### Info
Quick links + short descriptions for each tool, plus a tip button to tip Heimdall.

---

## Inscribe Page Instructions

## DRC-20 Deploy (first)
**Recommended:** always create a *new wallet for minting*.
- When first using the app: **do not use the node default wallet**.
- In the Inscribe page: click **New Wallet**, give it a label (e.g. `minting wallet`).
- Fund that wallet with DOGE.

**Before you deploy:**
- Pick a ticker/token name.
- Check marketplaces (like `doggy.market` or `nintondo.io`) to make sure the ticker isn’t already taken.
- Enter:
  - token/ticker
  - total supply
  - max per mint

**Deployer address:**
- Change the deployer address from your selected wallet to *another* wallet address if you want.
  - You don’t have to.
  - It just means the deploy UTXO ends up back in your minting wallet instead of another wallet.

**Deploy:**
- Click **Deploy**.
- Once the transaction confirms, your token is deployed.

---

## DRC-20 Minting
**Wallet rule:**
- If you haven’t created a minting wallet on this page before, make one now using **New Wallet**.
- Fund it with enough DOGE to cover the mints + fees.

**Mint speed options:**
- **Slow mode:** mint from a single UTXO
- **Fast mode:** use **Split UTXO** to split into 20 / 50 / 100 etc, then mint in parallel
  - Fast mode will still need occasional cooldowns to wait for UTXOs to confirm.

**Mint a batch to one address:**
1. Enter token name
2. Enter amount per mint
3. Enter the address you want to mint to
4. Enter how many mints (batch)
5. Click **Start Mint Batch**
6. Watch progress — errors will be reported if anything fails.

**Mint to many recipients (JSON list):**
1. Click **Load JSON List**
2. Upload a JSON file with recipients.
   Supported patterns:
   - holder style: `{ "owner": "D...", "items": <amount> }`
   - wallet style: `{ "wallet": "D...", "amount": <amount> }`
3. Click **Load**
4. Start minting — it will mint the set amounts to each recipient.

---

## Inscribing files (Doginals tab)
1. Make sure you have a wallet created for inscriptions (you can reuse your minting wallet).
2. Select that wallet.
3. Drag and drop all your files into the drop area (or click to select).
   - If inscribing multiple files: select them all at once.
4. Ensure the wallet has enough DOGE to cover the estimated cost.
   - The estimate is based on fee per KB.
5. **Important:** keep the wallet at **one UTXO only** for minting/inscribing.
6. Enter the destination address (where inscriptions should be sent).
7. Click the **Check** button, then click **Start Inscribing**.

If everything is correct, it will inscribe all files and return the inscription IDs.
Any errors will be reported in the UI/console.

---

## Troubleshooting
If something doesn’t load:
- open DevTools → **Network**
- verify your local API endpoints return HTTP 200
- confirm your node RPC is reachable and credentials are correct
- ensure `txindex=1` is enabled and the node is fully synced
- to close the server just ctrl + c while in your vs code terminal . will close the server 

---

## License
MIT License

Copyright (c) 2025 Heimdall

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
