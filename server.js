require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const app     = express();
app.use(express.json());

const CONFIG = {
  port          : process.env.PORT           || 3000,
  webhookSecret : process.env.WEBHOOK_SECRET || "my_secret_token",
  tradovate: {
    baseUrl   : "https://demo.tradovateapi.com/v1",
    name      : process.env.TV_USERNAME,
    password  : process.env.TV_PASSWORD,
    appId     : process.env.TV_APP_ID,
    appVersion: "1.0",
    cid       : process.env.TV_CID,
    sec       : process.env.TV_SEC,
  },
  risk: {
    maxDailyLoss        : 500,
    maxContractsPerTrade: 1,
    allowedSymbols      : ["MGC","MGCM5","MNQ","MNQM5","NQ","NQM5"],
    allowedActions      : ["buy"],
  }
};

let accessToken = null;
let tokenExpiry = null;
let dailyPnL    = 0;
let tradesLog   = [];

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;
  const res = await axios.post(`${CONFIG.tradovate.baseUrl}/auth/accesstokenrequest`, {
    name: CONFIG.tradovate.name, password: CONFIG.tradovate.password,
    appId: CONFIG.tradovate.appId, appVersion: CONFIG.tradovate.appVersion,
    cid: CONFIG.tradovate.cid, sec: CONFIG.tradovate.sec,
  });
  accessToken = res.data["access-token"];
  tokenExpiry = Date.now() + (55 * 60 * 1000);
  return accessToken;
}

async function getContractId(symbol) {
  const token = await getAccessToken();
  const res = await axios.get(`${CONFIG.tradovate.baseUrl}/contract/find?name=${symbol}`,
    { headers: { Authorization: `Bearer ${token}` } });
  return res.data.id;
}

async function getAccountId() {
  const token = await getAccessToken();
  const res = await axios.get(`${CONFIG.tradovate.baseUrl}/account/list`,
    { headers: { Authorization: `Bearer ${token}` } });
  return res.data[0].id;
}

async function placeOrder({ symbol, action, qty, sl }) {
  const token     = await getAccessToken();
  await getContractId(symbol);
  const accountId = await getAccountId();
  const res = await axios.post(`${CONFIG.tradovate.baseUrl}/order/placeorder`, {
    accountSpec: CONFIG.tradovate.name, accountId, action: "Buy",
    symbol, orderQty: qty, orderType: "Stop", isAutomated: true,
    bracket1: { action: "Sell", orderType: "Stop", stopPrice: sl, orderQty: qty }
  }, { headers: { Authorization: `Bearer ${token}` } });
  return res.data;
}

function passesRiskGate(p) {
  const reasons = [];
  if (!CONFIG.risk.allowedSymbols.includes(p.symbol)) reasons.push(`Symbol ${p.symbol} not allowed`);
  if (!CONFIG.risk.allowedActions.includes(p.action)) reasons.push(`Action ${p.action} not allowed`);
  if (p.qty > CONFIG.risk.maxContractsPerTrade) reasons.push(`Qty ${p.qty} exceeds max`);
  if (dailyPnL <= -CONFIG.risk.maxDailyLoss) reasons.push(`Daily loss limit hit`);
  return reasons.length ? { pass: false, reasons } : { pass: true };
}

app.post("/webhook", async (req, res) => {
  const secret = req.query.secret || req.headers["x-webhook-secret"];
  if (secret !== CONFIG.webhookSecret) return res.status(401).json({ error: "Unauthorised" });
  const payload = req.body;
  for (const f of ["strategy","symbol","action","qty","sl"]) {
    if (payload[f] == null) return res.status(400).json({ error: `Missing: ${f}` });
  }
  const risk = passesRiskGate(payload);
  if (!risk.pass) {
    tradesLog.push({ ...payload, status: "REJECTED", timestamp: new Date().toISOString() });
    return res.json({ status: "rejected", reasons: risk.reasons });
  }
  try {
    const result = await placeOrder(payload);
    tradesLog.push({ ...payload, status: "FILLED", orderId: result.orderId, timestamp: new Date().toISOString() });
    return res.json({ status: "order_placed", orderId: result.orderId });
  } catch (err) {
    tradesLog.push({ ...payload, status: "ERROR", error: err.message, timestamp: new Date().toISOString() });
    return res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "running", dailyPnL, trades: tradesLog.length }));
app.get("/trades", (req, res) => res.json(tradesLog));

app.listen(CONFIG.port, () => {
  console.log(`Bridge server running on port ${CONFIG.port}`);
  getAccessToken().catch(console.error);
});
