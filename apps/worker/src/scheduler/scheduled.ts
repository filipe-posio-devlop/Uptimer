import pLimit from 'p-limit';

import {
  expectedStatusJsonSchema,
  httpHeadersJsonSchema,
  parseDbJson,
  parseDbJsonNullable,
  webhookChannelConfigSchema,
  type MonitorStatus,
} from '@uptimer/db';

import type { Env } from '../env';
import { runHttpCheck } from '../monitor/http';
import { computeNextState, type MonitorStateSnapshot } from '../monitor/state-machine';
import { runTcpCheck } from '../monitor/tcp';
import type { CheckOutcome } from '../monitor/types';
import { dispatchWebhookToChannels, type WebhookChannel } from '../notify/webhook';
import { computePublicStatusPayload } from '../public/status';
import { refreshPublicStatusSnapshot } from '../snapshots';
import { acquireLease } from './lock';

const LOCK_NAME = 'scheduler:tick';
const LOCK_LEASE_SECONDS = 55;

const CHECK_CONCURRENCY = 5;

type DueMonitorRow = {
  id: number;
  name: string;
  type: string;
  target: string;
  interval_sec: number;
  timeout_ms: number;
  http_method: string | null;
  http_headers_json: string | null;
  http_body: string | null;
  expected_status_json: string | null;
  response_keyword: string | null;
  response_forbidden_keyword: string | null;
  state_status: string | null;
  state_last_error: string | null;
  last_changed_at: number | null;
  consecutive_failures: number | null;
  consecutive_successes: number | null;
};

type ActiveWebhookChannelRow = {
  id: number;
  name: string;
  config_json: string;
};

type NotifyContext = {
  ctx: ExecutionContext;
  envRecord: Record<string, unknown>;
  channels: WebhookChannel[];
};

async function listActiveWebhookChannels(db: D1Database): Promise<WebhookChannel[]> {
  const { results } = await db
    .prepare(
      `
      SELECT id, name, config_json
      FROM notification_channels
      WHERE is_active = 1 AND type = 'webhook'
      ORDER BY id
    `,
    )
    .all<ActiveWebhookChannelRow>();

  return (results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    config: parseDbJson(webhookChannelConfigSchema, r.config_json, { field: 'config_json' }),
  }));
}

async function listMaintenanceSuppressedMonitorIds(
  db: D1Database,
  at: number,
  monitorIds: number[],
): Promise<Set<number>> {
  const ids = [...new Set(monitorIds)];
  if (ids.length === 0) return new Set();

  const placeholders = ids.map((_, idx) => `?${idx + 2}`).join(', ');
  const sql = `
    SELECT DISTINCT mwm.monitor_id
    FROM maintenance_window_monitors mwm
    JOIN maintenance_windows mw ON mw.id = mwm.maintenance_window_id
    WHERE mw.starts_at <= ?1 AND mw.ends_at > ?1
      AND mwm.monitor_id IN (${placeholders})
  `;

  const { results } = await db.prepare(sql).bind(at, ...ids).all<{ monitor_id: number }>();
  return new Set((results ?? []).map((r) => r.monitor_id));
}

function toHttpMethod(value: string | null): 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | null {
  const normalized = (value ?? 'GET').toUpperCase();
  switch (normalized) {
    case 'GET':
    case 'POST':
    case 'PUT':
    case 'PATCH':
    case 'DELETE':
    case 'HEAD':
      return normalized;
    default:
      return null;
  }
}

function toMonitorStatus(value: string | null): MonitorStatus | null {
  switch (value) {
    case 'up':
    case 'down':
    case 'maintenance':
    case 'paused':
    case 'unknown':
      return value;
    default:
      return null;
  }
}

async function listDueMonitors(db: D1Database, checkedAt: number): Promise<DueMonitorRow[]> {
  const { results } = await db
    .prepare(
      `
      SELECT
        m.id,
        m.name,
        m.type,
        m.target,
        m.interval_sec,
        m.timeout_ms,
        m.http_method,
        m.http_headers_json,
        m.http_body,
        m.expected_status_json,
        m.response_keyword,
        m.response_forbidden_keyword,
        s.status AS state_status,
        s.last_error AS state_last_error,
        s.last_changed_at,
        s.consecutive_failures,
        s.consecutive_successes
      FROM monitors m
      LEFT JOIN monitor_state s ON s.monitor_id = m.id
      WHERE m.is_active = 1
        AND (s.status IS NULL OR s.status != 'paused')
        AND (s.last_checked_at IS NULL OR s.last_checked_at <= ?1 - m.interval_sec)
      ORDER BY m.id
    `,
    )
    .bind(checkedAt)
    .all<DueMonitorRow>();

  return results ?? [];
}

function computeStateLastError(
  nextStatus: MonitorStatus,
  outcome: CheckOutcome,
  prevLastError: string | null,
): string | null {
  if (nextStatus === 'down') {
    return outcome.status === 'up' ? prevLastError : outcome.error;
  }
  if (nextStatus === 'up') {
    return outcome.status === 'up' ? null : outcome.error;
  }
  return outcome.status === 'up' ? null : outcome.error;
}

async function persistCheckAndState(
  env: Env,
  monitorId: number,
  checkedAt: number,
  outcome: CheckOutcome,
  next: { status: MonitorStatus; lastChangedAt: number; consecutiveFailures: number; consecutiveSuccesses: number },
  outageAction: 'open' | 'close' | 'update' | 'none',
  stateLastError: string | null,
): Promise<void> {
  const checkError = outcome.status === 'up' ? null : outcome.error;

  const statements: D1PreparedStatement[] = [];

  statements.push(
    env.DB.prepare(
      `
      INSERT INTO check_results (
        monitor_id,
        checked_at,
        status,
        latency_ms,
        http_status,
        error,
        location,
        attempt
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `,
    ).bind(
      monitorId,
      checkedAt,
      outcome.status,
      outcome.latencyMs,
      outcome.httpStatus,
      checkError,
      null,
      outcome.attempts,
    ),
  );

  statements.push(
    env.DB.prepare(
      `
      INSERT INTO monitor_state (
        monitor_id,
        status,
        last_checked_at,
        last_changed_at,
        last_latency_ms,
        last_error,
        consecutive_failures,
        consecutive_successes
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(monitor_id) DO UPDATE SET
        status = excluded.status,
        last_checked_at = excluded.last_checked_at,
        last_changed_at = excluded.last_changed_at,
        last_latency_ms = excluded.last_latency_ms,
        last_error = excluded.last_error,
        consecutive_failures = excluded.consecutive_failures,
        consecutive_successes = excluded.consecutive_successes
    `,
    ).bind(
      monitorId,
      next.status,
      checkedAt,
      next.lastChangedAt,
      outcome.latencyMs,
      stateLastError,
      next.consecutiveFailures,
      next.consecutiveSuccesses,
    ),
  );

  if (outageAction === 'open') {
    statements.push(
      env.DB.prepare(
        `
        INSERT INTO outages (monitor_id, started_at, ended_at, initial_error, last_error)
        SELECT ?1, ?2, NULL, ?3, ?4
        WHERE NOT EXISTS (
          SELECT 1 FROM outages WHERE monitor_id = ?5 AND ended_at IS NULL
        )
      `,
      ).bind(monitorId, checkedAt, checkError ?? 'down', checkError ?? 'down', monitorId),
    );
  } else if (outageAction === 'close') {
    statements.push(
      env.DB.prepare(
        `
        UPDATE outages
        SET ended_at = ?1
        WHERE monitor_id = ?2 AND ended_at IS NULL
      `,
      ).bind(checkedAt, monitorId),
    );
  } else if (outageAction === 'update' && checkError) {
    statements.push(
      env.DB.prepare(
        `
        UPDATE outages
        SET last_error = ?1
        WHERE monitor_id = ?2 AND ended_at IS NULL
      `,
      ).bind(checkError, monitorId),
    );
  }

  await env.DB.batch(statements);
}

async function runDueMonitor(
  env: Env,
  row: DueMonitorRow,
  checkedAt: number,
  notify: NotifyContext | null,
  maintenanceSuppressed: boolean,
): Promise<void> {
  const prevStatus = toMonitorStatus(row.state_status);
  const prev: MonitorStateSnapshot | null =
    prevStatus === null
      ? null
      : {
          status: prevStatus,
          lastChangedAt: row.last_changed_at,
          consecutiveFailures: row.consecutive_failures ?? 0,
          consecutiveSuccesses: row.consecutive_successes ?? 0,
        };

  let outcome: CheckOutcome;

  try {
    if (row.type === 'http') {
      const httpMethod = toHttpMethod(row.http_method);
      if (!httpMethod) {
        outcome = {
          status: 'unknown',
          latencyMs: null,
          httpStatus: null,
          error: 'Invalid http_method',
          attempts: 1,
        };
      } else {
        const httpHeaders = parseDbJsonNullable(httpHeadersJsonSchema, row.http_headers_json, {
          field: 'http_headers_json',
        });
        const expectedStatus = parseDbJsonNullable(expectedStatusJsonSchema, row.expected_status_json, {
          field: 'expected_status_json',
        });

        outcome = await runHttpCheck({
          url: row.target,
          timeoutMs: row.timeout_ms,
          method: httpMethod,
          headers: httpHeaders,
          body: row.http_body,
          expectedStatus,
          responseKeyword: row.response_keyword,
          responseForbiddenKeyword: row.response_forbidden_keyword,
        });
      }
    } else if (row.type === 'tcp') {
      outcome = await runTcpCheck({ target: row.target, timeoutMs: row.timeout_ms });
    } else {
      outcome = {
        status: 'unknown',
        latencyMs: null,
        httpStatus: null,
        error: `Unsupported monitor type: ${String(row.type)}`,
        attempts: 1,
      };
    }
  } catch (err) {
    outcome = {
      status: 'unknown',
      latencyMs: null,
      httpStatus: null,
      error: err instanceof Error ? err.message : String(err),
      attempts: 1,
    };
  }

  const { next, outageAction } = computeNextState(prev, outcome, checkedAt);
  const stateLastError = computeStateLastError(next.status, outcome, row.state_last_error);

  await persistCheckAndState(
    env,
    row.id,
    checkedAt,
    outcome,
    {
      status: next.status,
      lastChangedAt: next.lastChangedAt,
      consecutiveFailures: next.consecutiveFailures,
      consecutiveSuccesses: next.consecutiveSuccesses,
    },
    outageAction,
    stateLastError,
  );

  if (!notify || maintenanceSuppressed || !next.changed) {
    return;
  }

  const prevForEvent: MonitorStatus = prevStatus ?? 'unknown';
  let eventType: 'monitor.down' | 'monitor.up' | null = null;

  if ((prevForEvent === 'up' || prevForEvent === 'unknown') && next.status === 'down') {
    eventType = 'monitor.down';
  } else if (prevForEvent === 'down' && next.status === 'up') {
    eventType = 'monitor.up';
  }

  if (!eventType) {
    return;
  }

  const eventSuffix = eventType === 'monitor.down' ? 'down' : 'up';
  const eventKey = `monitor:${row.id}:${eventSuffix}:${checkedAt}`;

  const payload = {
    event: eventType,
    event_id: eventKey,
    timestamp: checkedAt,
    monitor: {
      id: row.id,
      name: row.name,
      type: row.type,
      target: row.target,
    },
    state: {
      status: next.status,
      latency_ms: outcome.latencyMs,
      http_status: outcome.httpStatus,
      error: outcome.error,
      location: null,
    },
  };

  notify.ctx.waitUntil(
    dispatchWebhookToChannels({
      db: env.DB,
      env: notify.envRecord,
      channels: notify.channels,
      eventType,
      eventKey,
      payload,
    }).catch((err) => {
      console.error('notify: failed to dispatch webhooks', err);
    }),
  );
}

export async function runScheduledTick(env: Env, ctx: ExecutionContext): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const checkedAt = Math.floor(now / 60) * 60;

  const acquired = await acquireLease(env.DB, LOCK_NAME, now, LOCK_LEASE_SECONDS);
  if (!acquired) {
    return;
  }

  const due = await listDueMonitors(env.DB, checkedAt);
  if (due.length === 0) {
    // Still refresh snapshots even if no monitors are due.
    const snapshotNow = Math.floor(Date.now() / 1000);
    ctx.waitUntil(
      refreshPublicStatusSnapshot({
        db: env.DB,
        now: snapshotNow,
        compute: () => computePublicStatusPayload(env.DB, snapshotNow),
      }).catch((err) => {
        console.warn('scheduled: status snapshot refresh failed', err);
      }),
    );
    return;
  }

  const channels = await listActiveWebhookChannels(env.DB);
  const notify: NotifyContext | null =
    channels.length === 0 ? null : { ctx, envRecord: env as unknown as Record<string, unknown>, channels };

  // Maintenance suppression is monitor-scoped.
  const suppressedMonitorIds = await listMaintenanceSuppressedMonitorIds(
    env.DB,
    now,
    due.map((m) => m.id),
  );

  const limit = pLimit(CHECK_CONCURRENCY);
  const settled = await Promise.allSettled(
    due.map((m) => limit(() => runDueMonitor(env, m, checkedAt, notify, suppressedMonitorIds.has(m.id)))),
  );

  const rejected = settled.filter((r) => r.status === 'rejected');
  if (rejected.length > 0) {
    console.error(`scheduled: ${rejected.length}/${settled.length} monitors failed`, rejected[0]);
  } else {
    console.log(`scheduled: processed ${settled.length} monitors at ${checkedAt}`);
  }

  // Keep the public status snapshot fresh so the status page can load quickly.
  // Best-effort: ignore errors so monitoring checks are not impacted.
  const snapshotNow = Math.floor(Date.now() / 1000);
  ctx.waitUntil(
    refreshPublicStatusSnapshot({
      db: env.DB,
      now: snapshotNow,
      compute: () => computePublicStatusPayload(env.DB, snapshotNow),
    }).catch((err) => {
      console.warn('scheduled: status snapshot refresh failed', err);
    }),
  );
}
