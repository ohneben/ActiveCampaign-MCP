import { describe, it, expect } from "vitest";
import { RateLimiter } from "../src/rateLimiter.js";

describe("RateLimiter", () => {
  it("allows up to maxRequests immediately, then throttles", async () => {
    const limiter = new RateLimiter(4, 1000);
    const start = Date.now();
    // 4 slots should be granted with effectively no wait.
    for (let i = 0; i < 4; i++) await limiter.acquire();
    expect(Date.now() - start).toBeLessThan(50);

    // The 5th must wait for the window to roll.
    await limiter.acquire();
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
  });

  it("never lets more than maxRequests through within one window", async () => {
    const limiter = new RateLimiter(3, 300);
    const times: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        await limiter.acquire();
        times.push(Date.now());
      }),
    );
    // In any 300ms window there should be at most 3 acquisitions.
    for (const t of times) {
      const inWindow = times.filter((o) => o >= t && o < t + 300).length;
      expect(inWindow).toBeLessThanOrEqual(3);
    }
  });
});
