let cache: { value: number; expires: number } | null = null;
let inflightPromise: Promise<number> | null = null;
const TTL_MS = 60_000;
const FALLBACK_RATE = 5.00; // Sane fallback rate if upstream is entirely down

export function _resetCacheForTest() { 
  cache = null; 
  inflightPromise = null;
}

export async function getBrlPerUsdc(): Promise<number> {
  // Allow a fixed override in tests/CI to avoid hitting CoinGecko.
  const override = Deno.env.get("RATE_BRL_USDC");
  if (override) {
    const v = parseFloat(override);
    if (v > 0) return v;
  }

  // Return fresh cache if available
  if (cache && cache.expires > Date.now()) return cache.value;

  // Cache-stampede guard: share in-flight request across concurrent cold starts
  if (inflightPromise) {
    return inflightPromise;
  }

  inflightPromise = (async () => {
    try {
      const value = await fetchCoinGeckoWithRetry();
      cache = { value, expires: Date.now() + TTL_MS };
      return value;
    } catch (error) {
      console.warn("CoinGecko fetch failed, applying fallback policy:", error);
      
      // Fallback 1: Return stale cache if available
      if (cache) return cache.value;

      // Fallback 2: Hardcoded safe fallback to prevent unhandled throws/500s
      return FALLBACK_RATE;
    } finally {
      inflightPromise = null;
    }
  })();

  return inflightPromise;
}

async function fetchCoinGeckoWithRetry(retries = 2, timeoutMs = 4000): Promise<number> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=brl", {
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!r.ok) {
        if (r.status === 429 || r.status >= 500) {
          throw new Error(`coingecko retryable error ${r.status}`);
        }
        throw new Error(`coingecko client error ${r.status}`);
      }

      const j = await r.json() as { "usd-coin"?: { brl?: number } };
      const v = j["usd-coin"]?.brl;
      if (typeof v !== "number" || v <= 0) throw new Error("bad rate response");
      return v;
    } catch (err) {
      if (attempt === retries) throw err;
      // Exponential backoff delay
      await new Promise((res) => setTimeout(res, 500 * Math.pow(2, attempt)));
    }
  }
  throw new Error("Max retries exceeded");
}
