let cache: { value: number; expires: number } | null = null;
let inflightPromise: Promise<number> | null = null;

const TTL_MS = 60_000;
const TIMEOUT_MS = 4_000;
const RETRIES = 2;

export class RateUnavailableError extends Error {
  constructor() {
    super("BRL/USDC exchange rate is temporarily unavailable");
    this.name = "RateUnavailableError";
  }
}

class NonRetryableRateError extends Error {}

export function _resetCacheForTest() {
  cache = null;
  inflightPromise = null;
}

export async function getBrlPerUsdc(): Promise<number> {
  const override = Deno.env.get("RATE_BRL_USDC");
  if (override) {
    const value = Number(override);
    if (Number.isFinite(value) && value > 0) return value;
  }

  if (cache && cache.expires > Date.now()) {
    return cache.value;
  }

  if (inflightPromise) return inflightPromise;

  const request = fetchCoinGeckoWithRetry()
    .then((value) => {
      cache = { value, expires: Date.now() + TTL_MS };
      return value;
    })
    .catch((error: unknown) => {
      console.warn("CoinGecko rate fetch failed:", error);
      throw new RateUnavailableError();
    })
    .finally(() => {
      if (inflightPromise === request) inflightPromise = null;
    });

  inflightPromise = request;
  return request;
}

async function fetchCoinGeckoWithRetry(): Promise<number> {
  const url =
    "https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=brl";

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        const retryable =
          response.status === 429 || response.status >= 500;

        if (!retryable) {
          throw new NonRetryableRateError(
            `CoinGecko returned HTTP ${response.status}`,
          );
        }

        if (attempt === RETRIES) {
          throw new Error(`CoinGecko returned HTTP ${response.status}`);
        }

        await response.body?.cancel().catch(() => {});
      } else {
        const body = await response.json() as {
          "usd-coin"?: { brl?: number };
        };

        const value = body["usd-coin"]?.brl;
        if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          value <= 0
        ) {
          throw new Error("CoinGecko returned an invalid BRL rate");
        }

        return value;
      }
    } catch (error) {
      if (error instanceof NonRetryableRateError) throw error;
      if (attempt === RETRIES) throw error;
    } finally {
      clearTimeout(timer);
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 500 * 2 ** attempt)
    );
  }

  throw new Error("CoinGecko retries exhausted");
}
