import { CoralSwapClient } from '../src/client';
import { MonitoringModule } from '../src/modules/monitoring';
import { ProtocolMetrics, PoolMetrics } from '../src/types/monitoring';
import { Network } from '../src/types/common';
import { FactoryClient } from '../src/contracts/factory';

const TEST_SECRET =
  'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU';

const PAIR_A =
  'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const PAIR_B =
  'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC527';
const TOKEN_XLM =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const TOKEN_USDC =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
const LP_TOKEN =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';

/** Price map: XLM = $0.12, USDC = $1.00 (× 10^8) */
const PRICES: Record<string, bigint> = {
  XLM: 12_000_000n,   // $0.12 × 10^8
  USDC: 100_000_000n, // $1.00 × 10^8
};

/** Token-address → RedStone symbol mapping */
const TOKEN_SYMBOLS: Record<string, string> = {
  [TOKEN_XLM]: 'XLM',
  [TOKEN_USDC]: 'USDC',
};

// ---------------------------------------------------------------------------
// Helpers for creating pair/lpToken mocks
// ---------------------------------------------------------------------------

function makePairMock(overrides: {
  token0?: string;
  token1?: string;
  reserve0?: bigint;
  reserve1?: bigint;
  feeBps?: number;
  lpTokenAddress?: string;
} = {}): object {
  return {
    getTokens: jest.fn().mockResolvedValue({
      token0: overrides.token0 ?? TOKEN_XLM,
      token1: overrides.token1 ?? TOKEN_USDC,
    }),
    getReserves: jest.fn().mockResolvedValue({
      reserve0: overrides.reserve0 ?? 1_000_000_000n,
      reserve1: overrides.reserve1 ?? 500_000_000n,
    }),
    getDynamicFee: jest.fn().mockResolvedValue(overrides.feeBps ?? 30),
    getLPTokenAddress: jest
      .fn()
      .mockResolvedValue(overrides.lpTokenAddress ?? LP_TOKEN),
  };
}

function makeLPTokenMock(totalSupply = 1_000_000_000n): object {
  return {
    totalSupply: jest.fn().mockResolvedValue(totalSupply),
  };
}

/**
 * Install a mock factory on the client that bypasses the address check.
 * The factory getter lazily initialises a FactoryClient which requires a
 * non-empty factoryAddress.  We stub the whole getter to return a plain
 * mock object instead.
 */
function mockFactory(
  client: CoralSwapClient,
  getAllPairsFn: jest.Mock,
): void {
  Object.defineProperty(client, 'factory', {
    get: () => ({ getAllPairs: getAllPairsFn }),
    configurable: true,
  });
}

// ---------------------------------------------------------------------------

describe('MonitoringModule', () => {
  let client: CoralSwapClient;
  let monitoring: MonitoringModule;

  beforeEach(() => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });
    monitoring = new MonitoringModule(client);
  });

  afterEach(() => jest.restoreAllMocks());

  // -------------------------------------------------------------------------
  // getProtocolMetrics()
  // -------------------------------------------------------------------------

  describe('getProtocolMetrics()', () => {
    it('returns correct activePools count from factory', async () => {
      const getAllPairs = jest.fn().mockResolvedValue([PAIR_A, PAIR_B]);
      mockFactory(client, getAllPairs);

      jest
        .spyOn(client, 'pair')
        .mockReturnValueOnce(makePairMock() as ReturnType<typeof client.pair>)
        .mockReturnValueOnce(makePairMock() as ReturnType<typeof client.pair>);

      const metrics = await monitoring.getProtocolMetrics(PRICES, TOKEN_SYMBOLS);
      expect(metrics.activePools).toBe(2);
    });

    it('sums TVL across all pairs', async () => {
      mockFactory(client, jest.fn().mockResolvedValue([PAIR_A, PAIR_B]));

      // Pair A: 100 XLM + 50 USDC
      // XLM TVL = 1_000_000_000 * 12_000_000 / 10_000_000 = 1_200_000_000
      // USDC TVL = 500_000_000 * 100_000_000 / 10_000_000 = 5_000_000_000
      // Pair A total = 6_200_000_000
      const pairMockA = makePairMock({
        reserve0: 1_000_000_000n,
        reserve1: 500_000_000n,
      });

      // Pair B: 200 XLM + 100 USDC
      // XLM TVL = 2_000_000_000 * 12_000_000 / 10_000_000 = 2_400_000_000
      // USDC TVL = 1_000_000_000 * 100_000_000 / 10_000_000 = 10_000_000_000
      // Pair B total = 12_400_000_000
      const pairMockB = makePairMock({
        reserve0: 2_000_000_000n,
        reserve1: 1_000_000_000n,
      });

      jest
        .spyOn(client, 'pair')
        .mockReturnValueOnce(pairMockA as ReturnType<typeof client.pair>)
        .mockReturnValueOnce(pairMockB as ReturnType<typeof client.pair>);

      const metrics = await monitoring.getProtocolMetrics(PRICES, TOKEN_SYMBOLS);

      // Combined TVL = 6_200_000_000 + 12_400_000_000 = 18_600_000_000
      expect(metrics.tvlUSD).toBe(18_600_000_000n);
    });

    it('returns zero TVL when no pairs exist', async () => {
      mockFactory(client, jest.fn().mockResolvedValue([]));

      const metrics = await monitoring.getProtocolMetrics(PRICES, TOKEN_SYMBOLS);
      expect(metrics.tvlUSD).toBe(0n);
      expect(metrics.activePools).toBe(0);
    });

    it('returns zero values for event-based metrics (volume, users, swaps)', async () => {
      mockFactory(client, jest.fn().mockResolvedValue([PAIR_A]));
      jest
        .spyOn(client, 'pair')
        .mockReturnValue(makePairMock() as ReturnType<typeof client.pair>);

      const metrics = await monitoring.getProtocolMetrics(PRICES, TOKEN_SYMBOLS);
      expect(metrics.volume24hUSD).toBe(0n);
      expect(metrics.uniqueUsers24h).toBe(0);
      expect(metrics.totalSwaps24h).toBe(0);
      expect(metrics.avgSwapSizeUSD).toBe(0n);
    });

    it('includes a fetchedAt timestamp', async () => {
      mockFactory(client, jest.fn().mockResolvedValue([]));
      const before = Math.floor(Date.now() / 1000);
      const metrics = await monitoring.getProtocolMetrics(PRICES, TOKEN_SYMBOLS);
      const after = Math.floor(Date.now() / 1000);

      expect(metrics.fetchedAt).toBeGreaterThanOrEqual(before);
      expect(metrics.fetchedAt).toBeLessThanOrEqual(after);
    });

    it('silently skips a failing pair and still returns metrics for the rest', async () => {
      mockFactory(client, jest.fn().mockResolvedValue([PAIR_A, PAIR_B]));

      const failingPair = {
        getTokens: jest.fn().mockRejectedValue(new Error('RPC error')),
        getReserves: jest.fn().mockRejectedValue(new Error('RPC error')),
      };
      const workingPair = makePairMock({
        reserve0: 1_000_000_000n,
        reserve1: 500_000_000n,
      });

      jest
        .spyOn(client, 'pair')
        .mockReturnValueOnce(failingPair as unknown as ReturnType<typeof client.pair>)
        .mockReturnValueOnce(workingPair as ReturnType<typeof client.pair>);

      const metrics = await monitoring.getProtocolMetrics(PRICES, TOKEN_SYMBOLS);
      // Only the working pair contributes to TVL
      expect(metrics.tvlUSD).toBe(6_200_000_000n);
      // activePools still reflects factory's list
      expect(metrics.activePools).toBe(2);
    });

    it('treats tokens with unknown price symbols as zero contribution', async () => {
      mockFactory(client, jest.fn().mockResolvedValue([PAIR_A]));
      jest
        .spyOn(client, 'pair')
        .mockReturnValue(makePairMock({
          token0: TOKEN_XLM,
          token1: TOKEN_USDC,
          reserve0: 1_000_000_000n,
          reserve1: 500_000_000n,
        }) as ReturnType<typeof client.pair>);

      // No token symbols → both reserves have no known price
      const metrics = await monitoring.getProtocolMetrics(PRICES, {});
      expect(metrics.tvlUSD).toBe(0n);
    });

    it('returns cached result within TTL without making new RPC calls', async () => {
      const getAllPairs = jest.fn().mockResolvedValue([PAIR_A]);
      mockFactory(client, getAllPairs);
      jest
        .spyOn(client, 'pair')
        .mockReturnValue(makePairMock() as ReturnType<typeof client.pair>);

      // First call — populates the cache
      const first = await monitoring.getProtocolMetrics(PRICES, TOKEN_SYMBOLS);
      // Second call — should use cache
      const second = await monitoring.getProtocolMetrics(PRICES, TOKEN_SYMBOLS);

      expect(second).toBe(first); // same object reference
      expect(getAllPairs).toHaveBeenCalledTimes(1);
    });

    it('bypasses cache when bypassCache=true', async () => {
      const getAllPairs = jest.fn().mockResolvedValue([]);
      mockFactory(client, getAllPairs);

      await monitoring.getProtocolMetrics(PRICES, TOKEN_SYMBOLS);
      await monitoring.getProtocolMetrics(PRICES, TOKEN_SYMBOLS, true);

      expect(getAllPairs).toHaveBeenCalledTimes(2);
    });

    it('refetches after invalidateProtocolCache()', async () => {
      const getAllPairs = jest.fn().mockResolvedValue([]);
      mockFactory(client, getAllPairs);

      await monitoring.getProtocolMetrics(PRICES, TOKEN_SYMBOLS);
      monitoring.invalidateProtocolCache();
      await monitoring.getProtocolMetrics(PRICES, TOKEN_SYMBOLS);

      expect(getAllPairs).toHaveBeenCalledTimes(2);
    });

    it('refetches after TTL expires', async () => {
      jest.useFakeTimers();

      const getAllPairs = jest.fn().mockResolvedValue([]);

      // Use a short TTL of 1 second
      const shortTtlMonitoring = new MonitoringModule(client, 1_000);
      mockFactory(client, getAllPairs);

      await shortTtlMonitoring.getProtocolMetrics(PRICES, TOKEN_SYMBOLS);
      jest.advanceTimersByTime(1_001);
      await shortTtlMonitoring.getProtocolMetrics(PRICES, TOKEN_SYMBOLS);

      expect(getAllPairs).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // getPoolMetrics()
  // -------------------------------------------------------------------------

  describe('getPoolMetrics()', () => {
    it('returns correct pool data', async () => {
      jest
        .spyOn(client, 'pair')
        .mockReturnValue(makePairMock({
          token0: TOKEN_XLM,
          token1: TOKEN_USDC,
          reserve0: 1_000_000_000n,
          reserve1: 500_000_000n,
          feeBps: 30,
          lpTokenAddress: LP_TOKEN,
        }) as ReturnType<typeof client.pair>);
      jest
        .spyOn(client, 'lpToken')
        .mockReturnValue(
          makeLPTokenMock(2_000_000_000n) as ReturnType<typeof client.lpToken>,
        );

      const pool = await monitoring.getPoolMetrics(PAIR_A, PRICES, TOKEN_SYMBOLS);

      expect(pool.pairAddress).toBe(PAIR_A);
      expect(pool.token0).toBe(TOKEN_XLM);
      expect(pool.token1).toBe(TOKEN_USDC);
      expect(pool.reserve0).toBe(1_000_000_000n);
      expect(pool.reserve1).toBe(500_000_000n);
      expect(pool.feeBps).toBe(30);
      expect(pool.totalLPSupply).toBe(2_000_000_000n);
    });

    it('computes tvlUSD using RedStone prices', async () => {
      // reserve0: 1_000_000_000 XLM tokens (7 dec)
      // USD = 1_000_000_000 * 12_000_000 / 10_000_000 = 1_200_000_000
      // reserve1: 500_000_000 USDC tokens (7 dec)
      // USD = 500_000_000 * 100_000_000 / 10_000_000 = 5_000_000_000
      // tvlUSD = 6_200_000_000
      jest
        .spyOn(client, 'pair')
        .mockReturnValue(makePairMock({
          token0: TOKEN_XLM,
          token1: TOKEN_USDC,
          reserve0: 1_000_000_000n,
          reserve1: 500_000_000n,
        }) as ReturnType<typeof client.pair>);
      jest
        .spyOn(client, 'lpToken')
        .mockReturnValue(makeLPTokenMock() as ReturnType<typeof client.lpToken>);

      const pool = await monitoring.getPoolMetrics(PAIR_A, PRICES, TOKEN_SYMBOLS);
      expect(pool.tvlUSD).toBe(6_200_000_000n);
    });

    it('includes fetchedAt timestamp', async () => {
      jest
        .spyOn(client, 'pair')
        .mockReturnValue(makePairMock() as ReturnType<typeof client.pair>);
      jest
        .spyOn(client, 'lpToken')
        .mockReturnValue(makeLPTokenMock() as ReturnType<typeof client.lpToken>);

      const before = Math.floor(Date.now() / 1000);
      const pool = await monitoring.getPoolMetrics(PAIR_A, PRICES, TOKEN_SYMBOLS);
      const after = Math.floor(Date.now() / 1000);

      expect(pool.fetchedAt).toBeGreaterThanOrEqual(before);
      expect(pool.fetchedAt).toBeLessThanOrEqual(after);
    });

    it('caches result within TTL and avoids redundant RPC calls', async () => {
      const pairSpy = jest
        .spyOn(client, 'pair')
        .mockReturnValue(makePairMock() as ReturnType<typeof client.pair>);
      jest
        .spyOn(client, 'lpToken')
        .mockReturnValue(makeLPTokenMock() as ReturnType<typeof client.lpToken>);

      const first = await monitoring.getPoolMetrics(PAIR_A, PRICES, TOKEN_SYMBOLS);
      const second = await monitoring.getPoolMetrics(PAIR_A, PRICES, TOKEN_SYMBOLS);

      expect(second).toBe(first); // same object reference from cache
      expect(pairSpy).toHaveBeenCalledTimes(1);
    });

    it('bypasses pool cache when bypassCache=true', async () => {
      const pairSpy = jest
        .spyOn(client, 'pair')
        .mockReturnValue(makePairMock() as ReturnType<typeof client.pair>);
      jest
        .spyOn(client, 'lpToken')
        .mockReturnValue(makeLPTokenMock() as ReturnType<typeof client.lpToken>);

      await monitoring.getPoolMetrics(PAIR_A, PRICES, TOKEN_SYMBOLS);
      await monitoring.getPoolMetrics(PAIR_A, PRICES, TOKEN_SYMBOLS, true);

      expect(pairSpy).toHaveBeenCalledTimes(2);
    });

    it('invalidatePoolCache() for a specific pair clears only that entry', async () => {
      const pairSpy = jest
        .spyOn(client, 'pair')
        .mockReturnValue(makePairMock() as ReturnType<typeof client.pair>);
      jest
        .spyOn(client, 'lpToken')
        .mockReturnValue(makeLPTokenMock() as ReturnType<typeof client.lpToken>);

      // Prime caches for both pairs
      await monitoring.getPoolMetrics(PAIR_A, PRICES, TOKEN_SYMBOLS);
      await monitoring.getPoolMetrics(PAIR_B, PRICES, TOKEN_SYMBOLS);

      monitoring.invalidatePoolCache(PAIR_A);

      // PAIR_A should refetch
      await monitoring.getPoolMetrics(PAIR_A, PRICES, TOKEN_SYMBOLS);
      // PAIR_B should still be cached (no extra call)
      await monitoring.getPoolMetrics(PAIR_B, PRICES, TOKEN_SYMBOLS);

      // Calls: PAIR_A (1) + PAIR_B (1) + PAIR_A refetch (1) = 3
      expect(pairSpy).toHaveBeenCalledTimes(3);
    });

    it('invalidatePoolCache() with no argument clears all pool caches', async () => {
      const pairSpy = jest
        .spyOn(client, 'pair')
        .mockReturnValue(makePairMock() as ReturnType<typeof client.pair>);
      jest
        .spyOn(client, 'lpToken')
        .mockReturnValue(makeLPTokenMock() as ReturnType<typeof client.lpToken>);

      await monitoring.getPoolMetrics(PAIR_A, PRICES, TOKEN_SYMBOLS);
      await monitoring.getPoolMetrics(PAIR_B, PRICES, TOKEN_SYMBOLS);

      monitoring.invalidatePoolCache(); // clear all

      await monitoring.getPoolMetrics(PAIR_A, PRICES, TOKEN_SYMBOLS);
      await monitoring.getPoolMetrics(PAIR_B, PRICES, TOKEN_SYMBOLS);

      // 2 initial + 2 after invalidation = 4 calls
      expect(pairSpy).toHaveBeenCalledTimes(4);
    });

    it('refetches pool data after TTL expires', async () => {
      jest.useFakeTimers();

      const pairSpy = jest
        .spyOn(client, 'pair')
        .mockReturnValue(makePairMock() as ReturnType<typeof client.pair>);
      jest
        .spyOn(client, 'lpToken')
        .mockReturnValue(makeLPTokenMock() as ReturnType<typeof client.lpToken>);

      const shortTtlMonitoring = new MonitoringModule(client, 1_000);

      await shortTtlMonitoring.getPoolMetrics(PAIR_A, PRICES, TOKEN_SYMBOLS);
      jest.advanceTimersByTime(1_001);
      await shortTtlMonitoring.getPoolMetrics(PAIR_A, PRICES, TOKEN_SYMBOLS);

      expect(pairSpy).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    });

    it('returns tvlUSD of 0n when token symbols are not provided', async () => {
      jest
        .spyOn(client, 'pair')
        .mockReturnValue(makePairMock({
          token0: TOKEN_XLM,
          token1: TOKEN_USDC,
          reserve0: 1_000_000_000n,
          reserve1: 500_000_000n,
        }) as ReturnType<typeof client.pair>);
      jest
        .spyOn(client, 'lpToken')
        .mockReturnValue(makeLPTokenMock() as ReturnType<typeof client.lpToken>);

      const pool = await monitoring.getPoolMetrics(PAIR_A, PRICES, {});
      expect(pool.tvlUSD).toBe(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Type shape validation
  // -------------------------------------------------------------------------

  describe('Type exports from src/types/monitoring', () => {
    it('ProtocolMetrics shape is satisfied by getProtocolMetrics() return value', async () => {
      mockFactory(client, jest.fn().mockResolvedValue([]));

      const metrics: ProtocolMetrics =
        await monitoring.getProtocolMetrics(PRICES, TOKEN_SYMBOLS);

      expect(typeof metrics.tvlUSD).toBe('bigint');
      expect(typeof metrics.volume24hUSD).toBe('bigint');
      expect(typeof metrics.activePools).toBe('number');
      expect(typeof metrics.uniqueUsers24h).toBe('number');
      expect(typeof metrics.totalSwaps24h).toBe('number');
      expect(typeof metrics.avgSwapSizeUSD).toBe('bigint');
      expect(typeof metrics.fetchedAt).toBe('number');
    });

    it('PoolMetrics shape is satisfied by getPoolMetrics() return value', async () => {
      jest
        .spyOn(client, 'pair')
        .mockReturnValue(makePairMock() as ReturnType<typeof client.pair>);
      jest
        .spyOn(client, 'lpToken')
        .mockReturnValue(makeLPTokenMock() as ReturnType<typeof client.lpToken>);

      const pool: PoolMetrics = await monitoring.getPoolMetrics(
        PAIR_A,
        PRICES,
        TOKEN_SYMBOLS,
      );

      expect(typeof pool.pairAddress).toBe('string');
      expect(typeof pool.token0).toBe('string');
      expect(typeof pool.token1).toBe('string');
      expect(typeof pool.reserve0).toBe('bigint');
      expect(typeof pool.reserve1).toBe('bigint');
      expect(typeof pool.tvlUSD).toBe('bigint');
      expect(typeof pool.feeBps).toBe('number');
      expect(typeof pool.totalLPSupply).toBe('bigint');
      expect(typeof pool.fetchedAt).toBe('number');
    });
  });

  // -------------------------------------------------------------------------
  // Module export checks
  // -------------------------------------------------------------------------

  describe('Module exports', () => {
    it('MonitoringModule is exported from src/modules/index.ts', async () => {
      const { MonitoringModule: M } = await import('../src/modules/index');
      expect(M).toBeDefined();
      expect(typeof M).toBe('function');
    });

    it('MonitoringModule is exported from the top-level src/index.ts', async () => {
      const sdk = await import('../src/index');
      expect(sdk.MonitoringModule).toBeDefined();
      expect(typeof sdk.MonitoringModule).toBe('function');
    });

    it('ProtocolMetrics and PoolMetrics types are exported from src/types/monitoring', async () => {
      // Runtime-level check: the module resolves without error
      const types = await import('../src/types/monitoring');
      expect(types).toBeDefined();
    });
  });
});
