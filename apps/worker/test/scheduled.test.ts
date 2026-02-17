import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/public/status', () => ({
  computePublicStatusPayload: vi.fn(),
}));
vi.mock('../src/monitor/http', () => ({
  runHttpCheck: vi.fn(),
}));
vi.mock('../src/monitor/tcp', () => ({
  runTcpCheck: vi.fn(),
}));
vi.mock('../src/scheduler/lock', () => ({
  acquireLease: vi.fn(),
}));
vi.mock('../src/settings', () => ({
  readSettings: vi.fn(),
}));
vi.mock('../src/snapshots', () => ({
  refreshPublicStatusSnapshot: vi.fn(),
}));

import type { Env } from '../src/env';
import { computePublicStatusPayload } from '../src/public/status';
import { runScheduledTick } from '../src/scheduler/scheduled';
import { acquireLease } from '../src/scheduler/lock';
import { readSettings } from '../src/settings';
import { refreshPublicStatusSnapshot } from '../src/snapshots';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';

function createEnv(dueRows: unknown[] = []): Env {
  const handlers: FakeD1QueryHandler[] = [
    {
      match: 'from notification_channels',
      all: () => [],
    },
    {
      match: 'from monitors m',
      all: () => dueRows,
    },
  ];

  return {
    DB: createFakeD1Database(handlers),
  } as unknown as Env;
}

describe('scheduler/scheduled regression', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-17T00:00:42.000Z'));

    vi.mocked(acquireLease).mockResolvedValue(true);
    vi.mocked(readSettings).mockResolvedValue({
      site_title: 'Uptimer',
      site_description: '',
      site_locale: 'auto',
      site_timezone: 'UTC',
      retention_check_results_days: 7,
      state_failures_to_down_from_up: 2,
      state_successes_to_up_from_down: 2,
      admin_default_overview_range: '24h',
      admin_default_monitor_range: '24h',
      uptime_rating_level: 3,
    });
    vi.mocked(refreshPublicStatusSnapshot).mockResolvedValue(undefined);
    vi.mocked(computePublicStatusPayload).mockResolvedValue(
      {} as Awaited<ReturnType<typeof computePublicStatusPayload>>,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('returns immediately when scheduler lease is not acquired', async () => {
    vi.mocked(acquireLease).mockResolvedValue(false);

    const env = createEnv();
    const waitUntil = vi.fn();

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

    expect(readSettings).not.toHaveBeenCalled();
    expect(refreshPublicStatusSnapshot).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('still schedules snapshot refresh when no monitors are due', async () => {
    const env = createEnv([]);
    const waitUntil = vi.fn();
    const expectedNow = Math.floor(Date.now() / 1000);

    await runScheduledTick(env, { waitUntil } as unknown as ExecutionContext);

    expect(acquireLease).toHaveBeenCalledWith(env.DB, 'scheduler:tick', expectedNow, 55);
    expect(readSettings).toHaveBeenCalledTimes(1);
    expect(refreshPublicStatusSnapshot).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(computePublicStatusPayload).not.toHaveBeenCalled();

    const refreshArgs = vi.mocked(refreshPublicStatusSnapshot).mock.calls[0]?.[0];
    expect(refreshArgs).toBeDefined();
    expect(refreshArgs?.db).toBe(env.DB);
    expect(refreshArgs?.now).toBe(expectedNow);
    expect(typeof refreshArgs?.compute).toBe('function');

    if (!refreshArgs) {
      throw new Error('Expected refreshPublicStatusSnapshot to receive arguments');
    }

    await refreshArgs.compute();
    expect(computePublicStatusPayload).toHaveBeenCalledWith(env.DB, expectedNow);

    const scheduledPromise = waitUntil.mock.calls[0]?.[0];
    expect(scheduledPromise).toBeInstanceOf(Promise);
    await expect(scheduledPromise as Promise<unknown>).resolves.toBeUndefined();
  });
});
