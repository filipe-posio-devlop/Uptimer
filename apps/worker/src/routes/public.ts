import { Hono } from 'hono';
import { z } from 'zod';

import { getDb, monitors } from '@uptimer/db';

import type { Env } from '../env';
import { AppError } from '../middleware/errors';

export const publicRoutes = new Hono<{ Bindings: Env }>();

type PublicStatusMonitorRow = {
  id: number;
  name: string;
  type: string;
  interval_sec: number;
  state_status: string | null;
  last_checked_at: number | null;
  last_latency_ms: number | null;
};

type PublicHeartbeatRow = {
  monitor_id: number;
  checked_at: number;
  status: string;
  latency_ms: number | null;
};

type Interval = { start: number; end: number };

const HEARTBEAT_LIMIT = 60;
const HEARTBEAT_LOOKBACK_SEC = 7 * 24 * 60 * 60;

const latencyRangeSchema = z.enum(['24h']);
const uptimeRangeSchema = z.enum(['24h', '7d', '30d']);

function toMonitorStatus(value: string | null): 'up' | 'down' | 'maintenance' | 'paused' | 'unknown' {
  switch (value) {
    case 'up':
    case 'down':
    case 'maintenance':
    case 'paused':
    case 'unknown':
      return value;
    default:
      return 'unknown';
  }
}

function toCheckStatus(value: string | null): 'up' | 'down' | 'maintenance' | 'unknown' {
  switch (value) {
    case 'up':
    case 'down':
    case 'maintenance':
    case 'unknown':
      return value;
    default:
      return 'unknown';
  }
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const first = sorted[0];
  if (!first) return [];

  const merged: Interval[] = [{ start: first.start, end: first.end }];

  for (const cur of sorted.slice(1)) {
    if (!cur) continue;

    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push({ start: cur.start, end: cur.end });
      continue;
    }

    if (cur.start <= prev.end) {
      prev.end = Math.max(prev.end, cur.end);
      continue;
    }

    merged.push({ start: cur.start, end: cur.end });
  }

  return merged;
}

function sumIntervals(intervals: Interval[]): number {
  return intervals.reduce((acc, it) => acc + Math.max(0, it.end - it.start), 0);
}

function overlapSeconds(a: Interval[], b: Interval[]): number {
  let i = 0;
  let j = 0;
  let acc = 0;

  while (i < a.length && j < b.length) {
    const x = a[i];
    const y = b[j];
    if (!x || !y) break;

    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (end > start) {
      acc += end - start;
    }

    if (x.end <= y.end) {
      i++;
    } else {
      j++;
    }
  }

  return acc;
}

function ensureInterval(interval: Interval): Interval | null {
  if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end)) return null;
  if (interval.end <= interval.start) return null;
  return interval;
}

function pushMergedInterval(intervals: Interval[], next: Interval): void {
  const last = intervals[intervals.length - 1];
  if (last && next.start <= last.end) {
    last.end = Math.max(last.end, next.end);
    return;
  }
  intervals.push({ start: next.start, end: next.end });
}

function buildUnknownIntervals(
  rangeStart: number,
  rangeEnd: number,
  intervalSec: number,
  checks: Array<{ checked_at: number; status: string }>
): Interval[] {
  if (rangeEnd <= rangeStart) return [];
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    return [{ start: rangeStart, end: rangeEnd }];
  }

  let lastCheck: { checked_at: number; status: string } | null = null;
  let cursor = rangeStart;

  const unknown: Interval[] = [];

  function addUnknown(from: number, to: number) {
    const it = ensureInterval({ start: from, end: to });
    if (!it) return;
    pushMergedInterval(unknown, it);
  }

  function processSegment(segStart: number, segEnd: number) {
    if (segEnd <= segStart) return;

    if (!lastCheck) {
      addUnknown(segStart, segEnd);
      return;
    }

    const validUntil = lastCheck.checked_at + intervalSec;

    // Status only applies within [checked_at, checked_at + intervalSec). Beyond that, it's UNKNOWN.
    if (segStart >= validUntil) {
      addUnknown(segStart, segEnd);
      return;
    }

    const coveredEnd = Math.min(segEnd, validUntil);
    if (lastCheck.status === 'unknown') {
      addUnknown(segStart, coveredEnd);
    }

    if (coveredEnd < segEnd) {
      addUnknown(coveredEnd, segEnd);
    }
  }

  for (const check of checks) {
    if (check.checked_at < rangeStart) {
      lastCheck = check;
      continue;
    }
    if (check.checked_at >= rangeEnd) {
      break;
    }

    processSegment(cursor, check.checked_at);
    lastCheck = check;
    cursor = check.checked_at;
  }

  processSegment(cursor, rangeEnd);
  return unknown;
}

function rangeToSeconds(range: z.infer<typeof uptimeRangeSchema> | z.infer<typeof latencyRangeSchema>): number {
  switch (range) {
    case '24h':
      return 24 * 60 * 60;
    case '7d':
      return 7 * 24 * 60 * 60;
    case '30d':
      return 30 * 24 * 60 * 60;
    default: {
      const _exhaustive: never = range;
      return _exhaustive;
    }
  }
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1));
  return sorted[idx] ?? null;
}

publicRoutes.get('/status', async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const rangeEnd = Math.floor(now / 60) * 60;
  const lookbackStart = rangeEnd - HEARTBEAT_LOOKBACK_SEC;

  const { results } = await c.env.DB.prepare(
    `
      SELECT
        m.id,
        m.name,
        m.type,
        m.interval_sec,
        s.status AS state_status,
        s.last_checked_at,
        s.last_latency_ms
      FROM monitors m
      LEFT JOIN monitor_state s ON s.monitor_id = m.id
      WHERE m.is_active = 1
      ORDER BY m.id
    `
  ).all<PublicStatusMonitorRow>();

  const monitorsList = (results ?? []).map((r) => {
    const stateStatus = toMonitorStatus(r.state_status);

    // Paused/maintenance are operator-enforced; they should not degrade to "stale/unknown"
    // just because the scheduler isn't (or shouldn't be) running checks.
    const isStale =
      stateStatus === 'paused' || stateStatus === 'maintenance'
        ? false
        : r.last_checked_at === null
          ? true
          : now - r.last_checked_at > r.interval_sec * 2;

    const status = isStale ? 'unknown' : stateStatus;

    return {
      id: r.id,
      name: r.name,
      type: r.type,
      status,
      is_stale: isStale,
      last_checked_at: r.last_checked_at,
      last_latency_ms: isStale ? null : r.last_latency_ms,
      heartbeats: [] as Array<{ checked_at: number; status: ReturnType<typeof toCheckStatus>; latency_ms: number | null }>,
    };
  });

  const counts = { up: 0, down: 0, maintenance: 0, paused: 0, unknown: 0 };
  for (const m of monitorsList) {
    counts[m.status]++;
  }

  const overall_status: keyof typeof counts =
    counts.down > 0
      ? 'down'
      : counts.unknown > 0
        ? 'unknown'
        : counts.maintenance > 0
          ? 'maintenance'
          : counts.up > 0
            ? 'up'
            : counts.paused > 0
              ? 'paused'
              : 'unknown';

  const ids = monitorsList.map((m) => m.id);
  if (ids.length > 0) {
    const placeholders = ids.map((_, idx) => `?${idx + 1}`).join(', ');
    const rangeStartPlaceholder = `?${ids.length + 1}`;
    const limitPlaceholder = `?${ids.length + 2}`;

    const sql = `
      SELECT monitor_id, checked_at, status, latency_ms
      FROM (
        SELECT
          monitor_id,
          checked_at,
          status,
          latency_ms,
          ROW_NUMBER() OVER (PARTITION BY monitor_id ORDER BY checked_at DESC) AS rn
        FROM check_results
        WHERE monitor_id IN (${placeholders})
          AND checked_at >= ${rangeStartPlaceholder}
      ) t
      WHERE rn <= ${limitPlaceholder}
      ORDER BY monitor_id, checked_at DESC
    `;

    const { results: heartbeatRows } = await c.env.DB.prepare(sql)
      .bind(...ids, lookbackStart, HEARTBEAT_LIMIT)
      .all<PublicHeartbeatRow>();

    const byMonitor = new Map<number, Array<{ checked_at: number; status: ReturnType<typeof toCheckStatus>; latency_ms: number | null }>>();
    for (const r of heartbeatRows ?? []) {
      const existing = byMonitor.get(r.monitor_id) ?? [];
      existing.push({ checked_at: r.checked_at, status: toCheckStatus(r.status), latency_ms: r.latency_ms });
      byMonitor.set(r.monitor_id, existing);
    }

    for (const m of monitorsList) {
      const rows = byMonitor.get(m.id) ?? [];
      // Return chronological order for easier rendering on the client.
      m.heartbeats = rows.reverse();
    }
  }

  return c.json({
    generated_at: now,
    overall_status,
    summary: counts,
    monitors: monitorsList,
  });
});

publicRoutes.get('/monitors/:id/latency', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const range = latencyRangeSchema.optional().default('24h').parse(c.req.query('range'));

  const monitor = await c.env.DB.prepare(
    `
      SELECT id, name
      FROM monitors
      WHERE id = ?1 AND is_active = 1
    `
  )
    .bind(id)
    .first<{ id: number; name: string }>();

  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  const now = Math.floor(Date.now() / 1000);
  const rangeEnd = Math.floor(now / 60) * 60;
  const rangeStart = rangeEnd - rangeToSeconds(range);

  const { results } = await c.env.DB.prepare(
    `
      SELECT checked_at, status, latency_ms
      FROM check_results
      WHERE monitor_id = ?1
        AND checked_at >= ?2
        AND checked_at <= ?3
      ORDER BY checked_at
    `
  )
    .bind(id, rangeStart, rangeEnd)
    .all<{ checked_at: number; status: string; latency_ms: number | null }>();

  const points = (results ?? []).map((r) => ({
    checked_at: r.checked_at,
    status: toCheckStatus(r.status),
    latency_ms: r.latency_ms,
  }));

  const upLatencies = points
    .filter((p) => p.status === 'up' && typeof p.latency_ms === 'number')
    .map((p) => p.latency_ms as number);

  const avg_latency_ms =
    upLatencies.length === 0 ? null : Math.round(upLatencies.reduce((acc, v) => acc + v, 0) / upLatencies.length);

  return c.json({
    monitor: { id: monitor.id, name: monitor.name },
    range,
    range_start_at: rangeStart,
    range_end_at: rangeEnd,
    avg_latency_ms,
    p95_latency_ms: p95(upLatencies),
    points,
  });
});

type OutageRow = { started_at: number; ended_at: number | null };

publicRoutes.get('/monitors/:id/uptime', async (c) => {
  const id = z.coerce.number().int().positive().parse(c.req.param('id'));
  const range = uptimeRangeSchema.optional().default('24h').parse(c.req.query('range'));

  const monitor = await c.env.DB.prepare(
    `
      SELECT id, name, interval_sec, created_at
      FROM monitors
      WHERE id = ?1 AND is_active = 1
    `
  )
    .bind(id)
    .first<{ id: number; name: string; interval_sec: number; created_at: number }>();

  if (!monitor) {
    throw new AppError(404, 'NOT_FOUND', 'Monitor not found');
  }

  const now = Math.floor(Date.now() / 1000);
  const rangeEnd = Math.floor(now / 60) * 60;
  const requestedRangeStart = rangeEnd - rangeToSeconds(range);
  const rangeStart = Math.max(requestedRangeStart, monitor.created_at);

  const total_sec = Math.max(0, rangeEnd - rangeStart);

  const { results: outageRows } = await c.env.DB.prepare(
    `
      SELECT started_at, ended_at
      FROM outages
      WHERE monitor_id = ?1
        AND started_at < ?2
        AND (ended_at IS NULL OR ended_at > ?3)
      ORDER BY started_at
    `
  )
    .bind(id, rangeEnd, rangeStart)
    .all<OutageRow>();

  const downtimeIntervals = mergeIntervals(
    (outageRows ?? [])
      .map((r) => {
        const start = Math.max(r.started_at, rangeStart);
        const end = Math.min(r.ended_at ?? rangeEnd, rangeEnd);
        return { start, end };
      })
      .filter((it) => it.end > it.start)
  );
  const downtime_sec = sumIntervals(downtimeIntervals);

  const checksStart = rangeStart - monitor.interval_sec;
  const { results: checkRows } = await c.env.DB.prepare(
    `
      SELECT checked_at, status
      FROM check_results
      WHERE monitor_id = ?1
        AND checked_at >= ?2
        AND checked_at < ?3
      ORDER BY checked_at
    `
  )
    .bind(id, checksStart, rangeEnd)
    .all<{ checked_at: number; status: string }>();

  const unknownIntervals = buildUnknownIntervals(
    rangeStart,
    rangeEnd,
    monitor.interval_sec,
    (checkRows ?? []).map((r) => ({ checked_at: r.checked_at, status: toCheckStatus(r.status) }))
  );

  // Unknown time is treated as "unavailable" per Application.md; exclude overlap with downtime to avoid double counting.
  const unknown_sec = Math.max(0, sumIntervals(unknownIntervals) - overlapSeconds(unknownIntervals, downtimeIntervals));

  const unavailable_sec = Math.min(total_sec, downtime_sec + unknown_sec);
  const uptime_sec = Math.max(0, total_sec - unavailable_sec);
  const uptime_pct = total_sec === 0 ? 0 : (uptime_sec / total_sec) * 100;

  return c.json({
    monitor: { id: monitor.id, name: monitor.name },
    range,
    range_start_at: rangeStart,
    range_end_at: rangeEnd,
    total_sec,
    downtime_sec,
    unknown_sec,
    uptime_sec,
    uptime_pct,
  });
});

publicRoutes.get('/health', async (c) => {
  // Minimal DB touch to verify the Worker can connect to D1.
  const db = getDb(c.env);
  await db.select({ id: monitors.id }).from(monitors).limit(1).all();
  return c.json({ ok: true });
});
