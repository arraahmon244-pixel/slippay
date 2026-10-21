import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _resetCacheForTest,
  getBrlPerUsdc,
  RateUnavailableError,
} from "../lib/rate.ts";

const originalFetch = globalThis.fetch;
const originalOverride = Deno.env.get("RATE_BRL_USDC");

function mockFetch(handler: () => Promise<Response>) {
  globalThis.fetch = (() => handler()) as typeof fetch;
}

function rateResponse(rate = 5.8) {
  return new Response(JSON.stringify({ "usd-coin": { brl: rate } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function reset() {
  _resetCacheForTest();
  Deno.env.delete("RATE_BRL_USDC");
}

function restore() {
  globalThis.fetch = originalFetch;
  _resetCacheForTest();

  if (originalOverride === undefined) {
    Deno.env.delete("RATE_BRL_USDC");
  } else {
    Deno.env.set("RATE_BRL_USDC", originalOverride);
  }
}

Deno.test("fetches and caches a valid rate", async () => {
  reset();
  let calls = 0;
  mockFetch(async () => {
    calls++;
    return rateResponse(5.8);
  });

  try {
    assertEquals(await getBrlPerUsdc(), 5.8);
    assertEquals(await getBrlPerUsdc(), 5.8);
    assertEquals(calls, 1);
  } finally {
    restore();
  }
});

Deno.test("retries HTTP 500 and succeeds", async () => {
  reset();
  let calls = 0;
  mockFetch(async () => {
    calls++;
    return calls === 1
      ? new Response("upstream error", { status: 500 })
      : rateResponse(5.9);
  });

  try {
    assertEquals(await getBrlPerUsdc(), 5.9);
    assertEquals(calls, 2);
  } finally {
    restore();
  }
});

Deno.test("does not retry HTTP 400 and reports unavailable rate", async () => {
  reset();
  let calls = 0;
  mockFetch(async () => {
    calls++;
    return new Response("bad request", { status: 400 });
  });

  try {
    await assertRejects(
      () => getBrlPerUsdc(),
      RateUnavailableError,
    );
    assertEquals(calls, 1);
  } finally {
    restore();
  }
});

Deno.test("concurrent cold calls share one upstream request", async () => {
  reset();
  let calls = 0;
  mockFetch(async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return rateResponse(6.1);
  });

  try {
    const rates = await Promise.all([
      getBrlPerUsdc(),
      getBrlPerUsdc(),
      getBrlPerUsdc(),
    ]);

    assert(rates.every((rate) => rate === 6.1));
    assertEquals(calls, 1);
  } finally {
    restore();
  }
});

Deno.test("aborts stalled upstream requests and reports unavailable rate", async () => {
  reset();

  let calls = 0;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("Expected AbortSignal"));
        return;
      }
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  }) as typeof fetch;

  try {
    await assertRejects(
      () => getBrlPerUsdc(),
      RateUnavailableError,
    );
    assertEquals(calls, 3);
  } finally {
    restore();
  }
});
