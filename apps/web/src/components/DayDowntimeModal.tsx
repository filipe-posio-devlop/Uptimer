import { useMemo } from 'react';

import type { Incident, MaintenanceWindow, Outage } from '../api/types';
import { Button } from './ui';
import { formatDate, formatTime } from '../utils/datetime';
import { computeDayDowntimeIntervals, computeIntervalTotalSeconds } from './UptimeBar30d';

function formatDay(ts: number, timeZone?: string): string {
  return formatDate(ts, timeZone);
}

function formatClock(ts: number, timeZone?: string): string {
  return timeZone ? formatTime(ts, { timeZone, hour12: false }) : formatTime(ts, { hour12: false });
}

function formatSec(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

type DayInterval = { start: number; end: number };

type ContextInterval = {
  start: number;
  end: number;
  kind: 'maintenance' | 'incident';
  label: string;
};

type DowntimeGroup = {
  start: number;
  end: number;
  context: ContextInterval[];
  downtime: DayInterval[];
};

function mergeIntervals(intervals: DayInterval[]): DayInterval[] {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: DayInterval[] = [];

  for (const it of sorted) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push({ start: it.start, end: it.end });
      continue;
    }

    if (it.start <= prev.end) {
      prev.end = Math.max(prev.end, it.end);
      continue;
    }

    merged.push({ start: it.start, end: it.end });
  }

  return merged;
}

function clipInterval(interval: DayInterval, range: DayInterval): DayInterval | null {
  const start = Math.max(interval.start, range.start);
  const end = Math.min(interval.end, range.end);
  return end > start ? { start, end } : null;
}

function buildContextIntervals(
  dayStartAt: number,
  nowSec: number,
  maintenanceWindows: MaintenanceWindow[],
  incidents: Incident[],
): ContextInterval[] {
  const dayEndAt = dayStartAt + 86400;
  const capEndAt = dayStartAt <= nowSec && nowSec < dayEndAt ? nowSec : dayEndAt;

  const out: ContextInterval[] = [];

  for (const mw of maintenanceWindows) {
    const clipped = clipInterval(
      { start: mw.starts_at, end: mw.ends_at },
      { start: dayStartAt, end: capEndAt },
    );
    if (!clipped) continue;
    out.push({ start: clipped.start, end: clipped.end, kind: 'maintenance', label: mw.title });
  }

  for (const it of incidents) {
    const clipped = clipInterval(
      { start: it.started_at, end: it.resolved_at ?? capEndAt },
      { start: dayStartAt, end: capEndAt },
    );
    if (!clipped) continue;
    out.push({ start: clipped.start, end: clipped.end, kind: 'incident', label: it.title });
  }

  return out.sort((a, b) => a.start - b.start || (a.kind === b.kind ? 0 : a.kind === 'maintenance' ? -1 : 1));
}

function groupDowntimeWithContext(
  downtime: DayInterval[],
  context: ContextInterval[],
): { groups: DowntimeGroup[]; outside: DayInterval[] } {
  if (downtime.length === 0) return { groups: [], outside: [] };

  const mergedDowntime = mergeIntervals(downtime);
  const contextWindows = mergeIntervals(context.map((c) => ({ start: c.start, end: c.end })));

  const groups: DowntimeGroup[] = [];
  for (const win of contextWindows) {
    const clippedDowntime = mergedDowntime
      .map((d) => clipInterval(d, win))
      .filter((x): x is DayInterval => x !== null);

    if (clippedDowntime.length === 0) continue;

    const clippedContext = context
      .map((c) => {
        const clipped = clipInterval({ start: c.start, end: c.end }, win);
        return clipped ? { ...c, start: clipped.start, end: clipped.end } : null;
      })
      .filter((x): x is ContextInterval => x !== null)
      .sort((a, b) => a.start - b.start);

    groups.push({ start: win.start, end: win.end, context: clippedContext, downtime: clippedDowntime });
  }

  const outside: DayInterval[] = [];
  for (const d of mergedDowntime) {
    let cursor = d.start;

    for (const win of contextWindows) {
      if (win.end <= cursor) continue;
      if (win.start >= d.end) break;

      if (win.start > cursor) {
        outside.push({ start: cursor, end: Math.min(win.start, d.end) });
      }

      cursor = Math.max(cursor, win.end);
      if (cursor >= d.end) break;
    }

    if (cursor < d.end) {
      outside.push({ start: cursor, end: d.end });
    }
  }

  return { groups, outside };
}

function contextTagClasses(kind: ContextInterval['kind']): string {
  return kind === 'maintenance'
    ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300'
    : 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200';
}

export function DayDowntimeModal({
  dayStartAt,
  outages,
  maintenanceWindows,
  incidents,
  onClose,
  timeZone,
}: {
  dayStartAt: number;
  outages: Outage[];
  maintenanceWindows: MaintenanceWindow[];
  incidents: Incident[];
  onClose: () => void;
  timeZone?: string;
}) {
  const nowSec = Math.floor(Date.now() / 1000);

  const intervals = useMemo(
    () => computeDayDowntimeIntervals(dayStartAt, outages, nowSec),
    [dayStartAt, nowSec, outages],
  );

  const totalDowntimeSec = useMemo(() => computeIntervalTotalSeconds(intervals), [intervals]);

  const contextIntervals = useMemo(
    () => buildContextIntervals(dayStartAt, nowSec, maintenanceWindows, incidents),
    [dayStartAt, nowSec, maintenanceWindows, incidents],
  );

  const grouped = useMemo(
    () => groupDowntimeWithContext(intervals, contextIntervals),
    [intervals, contextIntervals],
  );

  return (
    <div
      className="fixed inset-0 bg-slate-900/60 dark:bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 z-50 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl shadow-soft-lg w-full sm:max-w-xl p-5 sm:p-6 max-h-[90vh] overflow-y-auto animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-1">
              Downtime
            </div>
            <h2 className="text-lg sm:text-xl font-semibold text-slate-900 dark:text-slate-100">
              {formatDay(dayStartAt, timeZone)}
            </h2>
            <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              Total: {formatSec(totalDowntimeSec)}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        {intervals.length === 0 ? (
          <div className="text-slate-500 dark:text-slate-400">No downtime recorded for this day.</div>
        ) : (
          <div className="space-y-3">
            {grouped.groups.map((g, idx) => (
              <div
                key={`group-${idx}`}
                className="p-3 rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50/40 dark:bg-blue-500/10"
              >
                <div className="flex items-center justify-between gap-4 mb-2">
                  <div className="text-sm font-medium text-blue-700 dark:text-blue-300">
                    Maintenance / Incident
                  </div>
                  <div className="text-xs text-blue-700/80 dark:text-blue-300/80 tabular-nums">
                    {formatClock(g.start, timeZone)} – {formatClock(g.end, timeZone)}
                  </div>
                </div>

                {g.context.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-3">
                    {g.context.map((c, cidx) => (
                      <span
                        key={`${c.kind}-${cidx}`}
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${contextTagClasses(c.kind)}`}
                        title={`${formatClock(c.start, timeZone)} – ${formatClock(c.end, timeZone)}`}
                      >
                        {c.kind === 'maintenance' ? 'Maintenance' : 'Incident'}: {c.label}
                      </span>
                    ))}
                  </div>
                )}

                <div className="space-y-2">
                  {g.downtime.map((it, didx) => (
                    <div
                      key={`d-${didx}`}
                      className="flex items-center justify-between gap-4 p-3 rounded-lg bg-white/70 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-700"
                    >
                      <div className="text-sm text-slate-700 dark:text-slate-200">
                        {formatClock(it.start, timeZone)} – {formatClock(it.end, timeZone)}
                      </div>
                      <div className="text-sm font-medium text-slate-900 dark:text-slate-100 tabular-nums">
                        {formatSec(it.end - it.start)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {grouped.outside.map((it, idx) => (
              <div
                key={`outside-${idx}`}
                className="flex items-center justify-between gap-4 p-3 rounded-lg bg-slate-50 dark:bg-slate-700/50"
              >
                <div className="text-sm text-slate-700 dark:text-slate-200">
                  {formatClock(it.start, timeZone)} – {formatClock(it.end, timeZone)}
                </div>
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100 tabular-nums">
                  {formatSec(it.end - it.start)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
