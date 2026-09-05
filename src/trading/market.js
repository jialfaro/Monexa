/**
 * Datos de mercado en tiempo real desde la API pública de Coinbase Exchange (sin clave).
 * Velas: [time, low, high, open, close, volume], se normalizan a orden ascendente.
 * Incluye metadatos de tokens en Base (AERO, VIRTUAL, cbBTC, ETH) y enlaces a DEXs (Uniswap, Aerodrome).
 */
const BASE = "https://api.exchange.coinbase.com";

export const BASE_TOKENS = {
  "AERO-USD": {
    symbol: "AERO",
    name: "Aerodrome Finance",
    network: "Base",
    chainId: 8453,
    address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
    dexName: "Aerodrome / Uniswap",
    dexUrl: "https://app.uniswap.org/swap?chain=base&outputCurrency=0x940181a94A35A4569E4529A3CDfB74e38FD98631"
  },
  "VIRTUAL-USD": {
    symbol: "VIRTUAL",
    name: "Virtuals Protocol",
    network: "Base",
    chainId: 8453,
    address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
    dexName: "Uniswap v3 (Base)",
    dexUrl: "https://app.uniswap.org/swap?chain=base&outputCurrency=0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b"
  },
  "ETH-USD": {
    symbol: "ETH",
    name: "Ethereum",
    network: "Base",
    chainId: 8453,
    address: "0x4200000000000000000000000000000000000006",
    dexName: "Uniswap v3 (Base)",
    dexUrl: "https://app.uniswap.org/swap?chain=base&outputCurrency=ETH"
  },
  "BTC-USD": {
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    network: "Base",
    chainId: 8453,
    address: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
    dexName: "Uniswap v3 (Base)",
    dexUrl: "https://app.uniswap.org/swap?chain=base&outputCurrency=0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf"
  },
  "SOL-USD": {
    symbol: "SOL",
    name: "Solana",
    network: "Coinbase / DEX",
    chainId: null,
    dexName: "Coinbase Spot",
    dexUrl: "https://www.coinbase.com/advanced-trade/spot/SOL-USD"
  }
};

export function getDexUrl(product) {
  return BASE_TOKENS[product]?.dexUrl || `https://app.uniswap.org/swap?chain=base`;
}

export function createMarket({ fetchJson, cacheMs = 60_000 }) {
  const cache = new Map();

  async function cached(key, loader) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < cacheMs) return hit.value;
    const value = await loader();
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  async function candles(product, granularity = 3600, limit = 200) {
    return cached(`candles:${product}:${granularity}`, async () => {
      const raw = await fetchJson(`${BASE}/products/${product}/candles?granularity=${granularity}`);
      if (!Array.isArray(raw)) throw new Error(`Velas no disponibles para ${product}`);
      return raw.slice(0, limit).reverse().map(([time, low, high, open, close, volume]) => ({ time, low, high, open, close, volume }));
    });
  }

  async function price(product) {
    return cached(`price:${product}`, async () => {
      const body = await fetchJson(`${BASE}/products/${product}/ticker`);
      const value = Number(body.price);
      if (!Number.isFinite(value)) throw new Error(`Precio no disponible para ${product}`);
      return value;
    });
  }

  async function stats24h(product) {
    return cached(`stats:${product}`, async () => {
      try {
        const body = await fetchJson(`${BASE}/products/${product}/stats`);
        const open = Number(body.open);
        const last = Number(body.last);
        const high = Number(body.high);
        const low = Number(body.low);
        const volume = Number(body.volume);
        const changePct = Number.isFinite(open) && open > 0 && Number.isFinite(last) ? ((last - open) / open) * 100 : 0;
        return { open, last, high, low, volume, changePct: Number(changePct.toFixed(2)) };
      } catch {
        return null;
      }
    });
  }

  async function snapshot(products, granularity) {
    const out = { at: new Date().toISOString(), granularity, candles: {}, prices: {}, stats: {}, errors: [] };
    for (const product of products) {
      try {
        out.candles[product] = await candles(product, granularity);
        out.prices[product] = await price(product);
        out.stats[product] = await stats24h(product);
      } catch (error) {
        out.errors.push({ product, message: error.message });
      }
    }
    return out;
  }

  return { candles, price, stats24h, snapshot, getDexUrl, tokens: BASE_TOKENS };
}
