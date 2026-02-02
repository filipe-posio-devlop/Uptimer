import { useMemo, useState } from 'react';
import type { CreateNotificationChannelInput, NotificationChannel, WebhookChannelConfig } from '../api/types';
import { Button } from './ui';

interface NotificationChannelFormProps {
  channel?: NotificationChannel | undefined;
  onSubmit: (data: CreateNotificationChannelInput) => void;
  onCancel: () => void;
  isLoading?: boolean;
  error?: string | undefined;
}

const inputClass =
  'w-full px-3 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:border-slate-400 dark:focus:border-slate-500 focus:ring-1 focus:ring-slate-400 dark:focus:ring-slate-500 transition-colors';
const labelClass = 'block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5';

type NotificationEventType = NonNullable<WebhookChannelConfig['enabled_events']>[number];

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

function toMethod(value: string): NonNullable<WebhookChannelConfig['method']> {
  switch (value) {
    case 'GET':
    case 'POST':
    case 'PUT':
    case 'PATCH':
    case 'DELETE':
    case 'HEAD':
      return value;
    default:
      return 'POST';
  }
}

function toPayloadType(value: string): NonNullable<WebhookChannelConfig['payload_type']> {
  switch (value) {
    case 'json':
    case 'param':
    case 'x-www-form-urlencoded':
      return value;
    default:
      return 'json';
  }
}

export function NotificationChannelForm({ channel, onSubmit, onCancel, isLoading, error }: NotificationChannelFormProps) {
  const [name, setName] = useState(channel?.name ?? '');
  const [url, setUrl] = useState(channel?.config_json.url ?? '');
  const [method, setMethod] = useState<NonNullable<WebhookChannelConfig['method']>>(
    channel?.config_json.method ?? 'POST',
  );

  const [timeoutMs, setTimeoutMs] = useState<number>(channel?.config_json.timeout_ms ?? 5000);
  const [payloadType, setPayloadType] = useState<NonNullable<WebhookChannelConfig['payload_type']>>(
    channel?.config_json.payload_type ?? 'json',
  );

  const [headersJson, setHeadersJson] = useState(safeJsonStringify(channel?.config_json.headers ?? {}));

  const [messageTemplate, setMessageTemplate] = useState(channel?.config_json.message_template ?? '');
  const [payloadTemplateJson, setPayloadTemplateJson] = useState(
    channel?.config_json.payload_template !== undefined
      ? safeJsonStringify(channel.config_json.payload_template)
      : '',
  );

  const [enabledEvents, setEnabledEvents] = useState<NotificationEventType[]>(
    channel?.config_json.enabled_events ?? [],
  );

  const [signingEnabled, setSigningEnabled] = useState<boolean>(channel?.config_json.signing?.enabled ?? false);
  const [signingSecretRef, setSigningSecretRef] = useState<string>(channel?.config_json.signing?.secret_ref ?? '');

  const headersParse = useMemo(() => {
    const trimmed = headersJson.trim();
    if (!trimmed) return { ok: true as const, value: {} as Record<string, string> };

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return { ok: false as const, error: 'Headers JSON must be valid JSON' };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false as const,
        error: 'Headers JSON must be an object (e.g. {"Authorization":"Bearer ..."})',
      };
    }

    for (const [k, vv] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof vv !== 'string') {
        return { ok: false as const, error: `Header "${k}" must be a string` };
      }
    }

    return { ok: true as const, value: parsed as Record<string, string> };
  }, [headersJson]);

  const payloadTemplateParse = useMemo(() => {
    const trimmed = payloadTemplateJson.trim();
    if (!trimmed) return { ok: true as const, value: undefined as unknown };

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return { ok: false as const, error: 'Payload template must be valid JSON' };
    }

    return { ok: true as const, value: parsed };
  }, [payloadTemplateJson]);

  const canSubmit = headersParse.ok && payloadTemplateParse.ok;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    const config: WebhookChannelConfig = {
      url,
      method,
      timeout_ms: timeoutMs,
      payload_type: payloadType,
    };

    if (headersParse.ok && Object.keys(headersParse.value).length > 0) {
      config.headers = headersParse.value;
    }

    if (messageTemplate.trim()) {
      config.message_template = messageTemplate;
    }

    if (payloadTemplateParse.ok && payloadTemplateParse.value !== undefined) {
      config.payload_template = payloadTemplateParse.value;
    }

    if (enabledEvents.length > 0) {
      config.enabled_events = enabledEvents;
    }

    if (signingEnabled) {
      config.signing = { enabled: true, secret_ref: signingSecretRef };
    }

    onSubmit({ name, type: 'webhook', config_json: config });
  };

  const toggleEnabledEvent = (ev: NotificationEventType) => {
    setEnabledEvents((prev) => (prev.includes(ev) ? prev.filter((x) => x !== ev) : [...prev, ev]));
  };

  const allEvents: NotificationEventType[] = [
    'monitor.down',
    'monitor.up',
    'incident.created',
    'incident.updated',
    'incident.resolved',
    'maintenance.started',
    'maintenance.ended',
  ];

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      <div>
        <label className={labelClass}>Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
          required
        />
      </div>

      <div>
        <label className={labelClass}>Webhook URL</label>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/webhook"
          className={inputClass}
          required
        />
      </div>

      <div>
        <label className={labelClass}>Method</label>
        <select value={method} onChange={(e) => setMethod(toMethod(e.target.value))} className={inputClass}>
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="PATCH">PATCH</option>
          <option value="DELETE">DELETE</option>
          <option value="GET">GET</option>
          <option value="HEAD">HEAD</option>
        </select>
      </div>

      <div>
        <label className={labelClass}>Payload Type</label>
        <select
          value={payloadType}
          onChange={(e) => setPayloadType(toPayloadType(e.target.value))}
          className={inputClass}
        >
          <option value="json">JSON</option>
          <option value="param">Query params</option>
          <option value="x-www-form-urlencoded">x-www-form-urlencoded</option>
        </select>
        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Non-JSON types only support a flat key/value payload_template object.
        </div>
      </div>

      <div>
        <label className={labelClass}>Timeout (ms)</label>
        <input
          type="number"
          min={1}
          max={60000}
          value={timeoutMs}
          onChange={(e) => setTimeoutMs(Number(e.target.value))}
          className={inputClass}
        />
      </div>

      <div>
        <label className={labelClass}>Headers (JSON)</label>
        <textarea
          value={headersJson}
          onChange={(e) => setHeadersJson(e.target.value)}
          className={inputClass}
          rows={4}
          placeholder='{"Authorization":"Bearer $TOKEN"}'
        />
        {!headersParse.ok && (
          <div className="mt-1 text-xs text-red-600 dark:text-red-400">{headersParse.error}</div>
        )}
        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Header values support magic variables like <code>{'{{message}}'}</code>.
        </div>
      </div>

      <div>
        <label className={labelClass}>Message Template (optional)</label>
        <textarea
          value={messageTemplate}
          onChange={(e) => setMessageTemplate(e.target.value)}
          className={inputClass}
          rows={3}
          placeholder="Monitor {{monitor.name}} changed to {{state.status}}\n$MSG"
        />
        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Available vars include: <code>{'{{event}}'}</code>, <code>{'{{event_id}}'}</code>,
          <code>{'{{monitor.name}}'}</code>, <code>{'{{state.error}}'}</code>, and <code>$MSG</code>.
        </div>
      </div>

      <div>
        <label className={labelClass}>Payload Template (JSON, optional)</label>
        <textarea
          value={payloadTemplateJson}
          onChange={(e) => setPayloadTemplateJson(e.target.value)}
          className={inputClass}
          rows={8}
          placeholder={
            payloadType === 'json'
              ? '{"text":"{{message}}","event":"{{event}}","monitor":"{{monitor.name}}"}'
              : '{"text":"{{message}}","event":"{{event}}"}'
          }
        />
        {!payloadTemplateParse.ok && (
          <div className="mt-1 text-xs text-red-600 dark:text-red-400">{payloadTemplateParse.error}</div>
        )}
        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Strings inside the template support <code>{'{{...}}'}</code> and <code>$MSG</code>.
        </div>
      </div>

      <div>
        <label className={labelClass}>Enabled Events (optional)</label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {allEvents.map((ev) => (
            <label
              key={ev}
              className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"
            >
              <input
                type="checkbox"
                checked={enabledEvents.includes(ev)}
                onChange={() => toggleEnabledEvent(ev)}
              />
              <span>{ev}</span>
            </label>
          ))}
        </div>
        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">Leave empty to send all events.</div>
      </div>

      <div className="border-t border-slate-200 dark:border-slate-700 pt-4">
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={signingEnabled}
            onChange={(e) => setSigningEnabled(e.target.checked)}
          />
          <span>Enable signing (HMAC-SHA256)</span>
        </label>
        {signingEnabled && (
          <div className="mt-3">
            <label className={labelClass}>Signing Secret Ref</label>
            <input
              type="text"
              value={signingSecretRef}
              onChange={(e) => setSigningSecretRef(e.target.value)}
              className={inputClass}
              placeholder="UPTIMER_WEBHOOK_SIGNING_SECRET"
              required
            />
          </div>
        )}
      </div>

      <div className="flex gap-3 pt-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="flex-1">
          Cancel
        </Button>
        <Button type="submit" disabled={isLoading || !canSubmit} className="flex-1">
          {isLoading ? 'Saving...' : channel ? 'Update' : 'Create'}
        </Button>
      </div>
    </form>
  );
}
