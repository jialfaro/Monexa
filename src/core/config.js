import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

function detectLanIp() {
  try {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === "IPv4" && !net.internal) {
          return net.address;
        }
      }
    }
  } catch {}
  return "127.0.0.1";
}

/**
 * Carga .env (sin dependencias) y construye la configuración del enjambre.
 * Nunca se guardan claves privadas ni frases semilla: sólo una dirección pública de cobro.
 */
export function loadDotEnv(rootDirectory) {
  const file = resolve(rootDirectory, ".env");
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const comment = value.search(/\s#/);
    if (comment !== -1 && !value.startsWith('"') && !value.startsWith("'")) value = value.slice(0, comment).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const NETWORKS = {
  "eip155:8453": {
    label: "Base",
    rpcUrl: "https://mainnet.base.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    explorer: "https://basescan.org",
    testnet: false
  },
  "eip155:84532": {
    label: "Base Sepolia",
    rpcUrl: "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    explorer: "https://sepolia.basescan.org",
    testnet: true
  }
};

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function buildConfig(env = process.env) {
  const network = env.X402_NETWORK || "eip155:84532";
  const chain = NETWORKS[network];
  if (!chain) throw new Error(`Red no soportada: ${network}. Usa eip155:8453 (Base) o eip155:84532 (Base Sepolia).`);

  const port = num(env.PORT, 4173);
  const lanIp = detectLanIp();
  const lanUrl = `http://${lanIp}:${port}`;
  return {
    port,
    host: env.HOST || "0.0.0.0",
    lanIp,
    lanUrl,
    remoteDashboard: bool(env.REMOTE_DASHBOARD, true),
    publicUrl: (env.PUBLIC_URL || `http://127.0.0.1:${port}`).replace(/\/$/, ""),
    tunnel: (env.TUNNEL || "none").toLowerCase(),
    ngrok: { domain: env.NGROK_DOMAIN || "", authtoken: env.NGROK_AUTHTOKEN || "" },
    cloudflare: { token: env.CLOUDFLARE_TUNNEL_TOKEN || "", url: env.CLOUDFLARE_TUNNEL_URL || "" },
    mongoUri: env.MONGODB_URI || env.MONGO_URI || "mongodb+srv://jaimeyt5678_db_user:dzr8Htje03jLCvEf@monexa.ecknofm.mongodb.net/?appName=Monexa",
    // Claves de modelo: se usa la del proveedor elegido en LLM_PROVIDER (o la primera disponible) y las demás como respaldo.
    anthropic: {
      apiKey: env.ANTHROPIC_API_KEY || "",
      anthropicKey: env.ANTHROPIC_API_KEY || "",
      openaiKey: env.OPENAI_API_KEY || "",
      geminiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "",
      provider: (env.LLM_PROVIDER || "auto").toLowerCase(),
      fallback: bool(env.LLM_FALLBACK, true),
      geminiFreeTier: bool(env.GEMINI_FREE_TIER, true),
      openaiServiceTier: (env.OPENAI_SERVICE_TIER || "").toLowerCase(), // "flex" = -50 % de precio a cambio de latencia variable
      workerModel: env.WORKER_MODEL || "",
      scoutModel: env.SCOUT_MODEL || "",
      dailyBudgetUsd: num(env.DAILY_LLM_BUDGET_USD, 5)
    },
    github: {
      token: env.GITHUB_TOKEN || "",
      user: env.GITHUB_USER || "",
      // La primera consulta identifica bounties donde comentó el bot de Algora (pagador verificado, no falsificable).
      queries: (env.GITHUB_BOUNTY_QUERIES ||
        'state:open commenter:algora-pbc[bot] -label:"💰 Rewarded",label:bounty state:open,label:"💎 Bounty" state:open,"/bounty $" in:comments state:open')
        .split(",").map((q) => q.trim()).filter(Boolean)
    },
    x402: {
      enabled: bool(env.X402_ENABLED, true),
      network,
      chain: { ...chain, rpcUrl: env.RPC_URL || chain.rpcUrl },
      payTo: env.PAYTO_ADDRESS || "0xf138f07cE4F8C69B0A500D41d1D9b620E48687C2",
      facilitatorUrl: (env.X402_FACILITATOR_URL || "https://x402.org/facilitator").replace(/\/$/, ""),
      facilitatorAuth: env.X402_FACILITATOR_AUTH || "",
      bazaarUrl: env.X402_BAZAAR_URL || "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources",
      defaultPriceUsd: num(env.X402_DEFAULT_PRICE_USD, 0.01)
    },
    policy: {
      autoSubmitMode: (() => {
        const clean = String(env.AUTO_SUBMIT ?? "").split(/[\s#]/)[0].trim().toLowerCase();
        if (["always", "true", "1", "yes", "on"].includes(clean)) return "always";
        if (clean === "verified") return "verified";
        return "never";
      })(),
      autoSubmit: (() => {
        const clean = String(env.AUTO_SUBMIT ?? "").split(/[\s#]/)[0].trim().toLowerCase();
        return ["always", "true", "1", "yes", "on"].includes(clean);
      })(),
      maxJobCostUsd: num(env.MAX_JOB_COST_USD, 0.5),
      maxEstimatedHours: num(env.MAX_ESTIMATED_HOURS, 6),
      maxAttemptsPerOpportunity: num(env.MAX_ATTEMPTS_PER_OPPORTUNITY, 2),
      minHeuristicForJudgement: num(env.MIN_HEURISTIC_FOR_JUDGEMENT, 25),
      minReviewConfidence: num(env.MIN_REVIEW_CONFIDENCE, 80),
      autoScale: bool(env.AUTO_SCALE, true),
      maxAgents: num(env.MAX_AGENTS, 8),
      maxDepth: num(env.MAX_DEPTH, 3),
      maxChildrenPerAgent: num(env.MAX_CHILDREN_PER_AGENT, 4),
      maxConcurrentWorkers: num(env.MAX_CONCURRENT_WORKERS, 2),
      scoutIntervalMs: num(env.SCOUT_INTERVAL_MINUTES, 30) * 60_000,
      reconcileIntervalMs: num(env.RECONCILE_INTERVAL_MINUTES, 10) * 60_000,
      minScore: num(env.MIN_OPPORTUNITY_SCORE, 60),
      maxWorkerIterations: num(env.MAX_WORKER_ITERATIONS, 25),
      blockedRepos: (env.BLOCKED_REPOS || "").split(",").map((r) => r.trim()).filter(Boolean),
      allowedSourceHosts: ["api.github.com", "github.com", "api.cdp.coinbase.com", "api.exchange.coinbase.com"]
        .concat((env.EXTRA_SOURCE_HOSTS || "").split(",").map((h) => h.trim()).filter(Boolean))
    },
    extraFeeds: (env.EXTRA_JSON_FEEDS || "").split(",").map((u) => u.trim()).filter(Boolean),
    // Apartado Trader: operaciones con dinero real sobre la red Base (EIP-155:8453) y Coinbase.
    trader: {
      enabled: bool(env.TRADER_ENABLED, true),
      mode: "real",
      executionMode: (env.TRADER_EXECUTION_MODE || "auto").toLowerCase(), // "auto" (opera on-chain si hay clave) o "manual"
      privateKey: env.TRADER_PRIVATE_KEY || env.EVM_PRIVATE_KEY || "",
      rpcUrl: env.BASE_RPC_URL || env.RPC_URL || "https://mainnet.base.org",
      maxOrderUsd: num(env.TRADER_MAX_ORDER_USD, 15),
      slippageTolerancePct: num(env.TRADER_SLIPPAGE_PCT, 0.015),
      minEthGas: num(env.TRADER_MIN_ETH_GAS, 0.0003),
      tradingCapitalUsd: num(env.TRADING_CAPITAL_USD || env.PAPER_START_USD, 1000),
      paperStartUsd: num(env.TRADING_CAPITAL_USD || env.PAPER_START_USD, 1000),
      watchlist: (env.TRADER_WATCHLIST || "BTC-USD,ETH-USD,SOL-USD,AERO-USD,VIRTUAL-USD").split(",").map((p) => p.trim().toUpperCase()).filter(Boolean),
      feeRate: num(env.TRADER_FEE_RATE, 0.006),
      tickMs: num(env.TRADER_TICK_MINUTES, 15) * 60_000,
      granularity: num(env.TRADER_CANDLE_SECONDS, 900),
      maxPositionPct: num(env.TRADER_MAX_POSITION_PCT, 0.2),
      maxExposurePct: num(env.TRADER_MAX_EXPOSURE_PCT, 0.6),
      stopLossPct: num(env.TRADER_STOP_LOSS_PCT, 0.03),
      takeProfitPct: num(env.TRADER_TAKE_PROFIT_PCT, 0.06),
      dailyLossLimitPct: num(env.TRADER_DAILY_LOSS_LIMIT_PCT, 0.05),
      minStrength: num(env.TRADER_MIN_STRENGTH, 0.55),
      minOrderUsd: num(env.TRADER_MIN_ORDER_USD, 5)
    }
  };
}

export { NETWORKS };
