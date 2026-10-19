const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=brl';
export const DEFAULT_FALLBACK_BRL_PER_USDC = 5.4;

interface CachedRate {
  rate: number;
  timestamp: number;
  stale: boolean;
}

let inFlightPromise: Promise<number> | null = null;
let lastKnownRate: CachedRate | null = null;
const CACHE_TTL_MS = 60_000; // 60s cache

async function fetchWithTimeout(url: string, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } finally {
    clearTimeout(id);
  }
}

async function fetchCoinGeckoWithRetry(retries = 2, delayMs = 300): Promise<number> {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      const res = await fetchWithTimeout(COINGECKO_URL, 5000);
      if (!res.ok) {
        throw new Error(`Upstream returned status ${res.status}`);
      }
      const data = await res.json();
      const rate = data?.['usd-coin']?.brl;
      if (typeof rate !== 'number') {
        throw new Error('Invalid rate payload from upstream');
      }
      return rate;
    } catch (err) {
      attempt++;
      if (attempt > retries) throw err;
      // Exponential backoff
      await new Promise((res) => setTimeout(res, delayMs * Math.pow(2, attempt - 1)));
    }
  }
  throw new Error('Failed to fetch rate after retries');
}

export async function getBrlPerUsdc(): Promise<{ rate: number; stale: boolean }> {
  const now = Date.now();

  // Return fresh cache if available
  if (lastKnownRate && now - lastKnownRate.timestamp < CACHE_TTL_MS) {
    return { rate: lastKnownRate.rate, stale: false };
  }

  // Singleflight: If a request is already in-flight, await it
  if (inFlightPromise) {
    try {
      const rate = await inFlightPromise;
      return { rate, stale: false };
    } catch {
      // If the shared call failed, fall back below
    }
  }

  // Deduplicate upstream request
  inFlightPromise = fetchCoinGeckoWithRetry();

  try {
    const rate = await inFlightPromise;
    lastKnownRate = { rate, timestamp: Date.now(), stale: false };
    return { rate, stale: false };
  } catch (error) {
    // Fallback strategy: return last known rate or default constant, flagged stale
    if (lastKnownRate) {
      return { rate: lastKnownRate.rate, stale: true };
    }
    return { rate: DEFAULT_FALLBACK_BRL_PER_USDC, stale: true };
  } finally {
    inFlightPromise = null;
  }
}
