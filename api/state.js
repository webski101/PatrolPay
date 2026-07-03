// Vercel serverless function — read-only on-chain state for the PatrolPay
// dashboard. Mirrors the chain-polling logic in dashboard.js, but stateless:
// every invocation re-reads ReceiptPaid logs (~40k-block lookback), the
// contract balance, and the device struct straight from the BOT Chain RPC.
// There is no audit-log file in serverless, so audit is reported as remote
// and the feed is built purely from on-chain ReceiptPaid events.
"use strict";

// Precomputed constants (same as dashboard.js):
//   TOPIC_RECEIPT_PAID = keccak256("ReceiptPaid(address,uint256,uint256,bytes32,uint256)")
//   SEL_DEVICES        = keccak256("devices(address)")[0:4]
const TOPIC_RECEIPT_PAID = "0x414d23aba2fb1e43262f7ab4d6e2085ecfc857c1ad8176efe458cbc95cc6b852";
const SEL_DEVICES = "0xe7b4cac6";

const EXPLORER = "https://scan.bohr.life";
const LOOKBACK_BLOCKS = 40000n; // ~8h at 0.75s blocks
const BLOCK_TIME_MS = 750;

let rpcId = 0;
async function rpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const hexToBigInt = (h) => (h && h !== "0x" ? BigInt(h) : 0n);
const word = (data, i) => "0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64);
const topicToAddress = (t) => "0x" + t.slice(26);

module.exports = async (req, res) => {
  const rpcUrl = process.env.RPC_URL || "https://rpc.bohr.life";
  const contract = (process.env.CONTRACT_ADDRESS || "").toLowerCase();

  const state = {
    contract,
    explorer: EXPLORER,
    rpcOk: false,
    budgetWei: "0",
    device: null,
    paidEvents: [],
    feed: [],
    audit: { entries: null, intact: null, remote: true },
    deviceLastSeen: null,
    updatedAt: null,
  };

  if (contract) {
    try {
      const latest = hexToBigInt(await rpc(rpcUrl, "eth_blockNumber", []));
      const from = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;

      const [logs, balance, latestBlock] = await Promise.all([
        rpc(rpcUrl, "eth_getLogs", [
          {
            address: contract,
            topics: [TOPIC_RECEIPT_PAID],
            fromBlock: "0x" + from.toString(16),
            toBlock: "latest",
          },
        ]),
        rpc(rpcUrl, "eth_getBalance", [contract, "latest"]),
        rpc(rpcUrl, "eth_getBlockByNumber", ["latest", false]),
      ]);

      state.budgetWei = hexToBigInt(balance).toString();
      const latestNum = Number(latest);
      const latestTsMs = Number(hexToBigInt(latestBlock.timestamp)) * 1000;

      // ReceiptPaid(address indexed device, uint256 indexed nonce,
      //             uint256 workUnits, bytes32 dataHash, uint256 amount)
      const events = logs.map((log) => ({
        device: topicToAddress(log.topics[1]),
        nonce: hexToBigInt(log.topics[2]).toString(),
        workUnits: hexToBigInt(word(log.data, 0)).toString(),
        dataHash: word(log.data, 1),
        amountWei: hexToBigInt(word(log.data, 2)).toString(),
        txHash: log.transactionHash,
        block: Number(hexToBigInt(log.blockNumber)),
      }));
      state.paidEvents = events.slice(-200);

      // Wall-clock time per event is estimated from block distance (0.75s
      // blocks) — exact timestamps would cost one eth_getBlockByNumber each.
      state.feed = events.slice(-100).map((e) => ({
        ts: new Date(latestTsMs - (latestNum - e.block) * BLOCK_TIME_MS).toISOString(),
        kind: "paid",
        nonce: e.nonce,
        txHash: e.txHash,
        block: e.block,
      }));

      const newest = events[events.length - 1];
      if (newest) {
        // deviceLastSeen uses the newest event's exact block timestamp.
        const evBlock = await rpc(rpcUrl, "eth_getBlockByNumber", [
          "0x" + newest.block.toString(16),
          false,
        ]);
        state.deviceLastSeen = {
          ts: new Date(Number(hexToBigInt(evBlock.timestamp)) * 1000).toISOString(),
          address: newest.device,
        };

        // devices(deviceAddress) — decode the 9-word struct return.
        const data = SEL_DEVICES + newest.device.slice(2).toLowerCase().padStart(64, "0");
        const ret = await rpc(rpcUrl, "eth_call", [{ to: contract, data }, "latest"]);
        if (ret && ret.length >= 2 + 9 * 64) {
          state.device = {
            address: newest.device,
            registered: hexToBigInt(word(ret, 0)) === 1n,
            active: hexToBigInt(word(ret, 1)) === 1n,
            ratePerReceiptWei: hexToBigInt(word(ret, 2)).toString(),
            nextNonce: hexToBigInt(word(ret, 4)).toString(),
            totalEarnedWei: hexToBigInt(word(ret, 7)).toString(),
            totalReceipts: hexToBigInt(word(ret, 8)).toString(),
          };
        }
      }

      state.rpcOk = true;
    } catch (err) {
      state.error = String((err && err.message) || err);
    }
  }

  state.updatedAt = new Date().toISOString();
  res.setHeader("Cache-Control", "s-maxage=3, stale-while-revalidate=10");
  res.status(200).json(state);
};
