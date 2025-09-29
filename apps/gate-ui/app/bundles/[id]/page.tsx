'use client';

import { useParams, useRouter } from 'next/navigation';
import useSWR from 'swr';
import { useEffect, useMemo, useState } from 'react';
import {
  approveBundle,
  commitBundle,
  fetchBundlePlan,
  revertBundle
} from '../../../lib/api';
import type { PlanResponse, PlanIntentSummary } from '../../../lib/types';
import { useAuth } from '../../../components/auth-context';
import { useToast } from '../../../components/toast-context';
import { FsDiffViewer } from '../../../components/fs-diff-viewer';
import { NetworkViewer } from '../../../components/network-viewer';
import { PromptsViewer } from '../../../components/prompts-viewer';

const fetcher = (id: string) => fetchBundlePlan(id);

export default function BundleDetailPage() {
  const params = useParams<{ id: string }>();
  const bundleId = params.id;
  const router = useRouter();
  const { user, isReady } = useAuth();
  const { addToast } = useToast();
  const [activeTab, setActiveTab] = useState<'intents' | 'fs' | 'network' | 'prompts'>('intents');

  useEffect(() => {
    if (isReady && !user) {
      router.replace('/login');
    }
  }, [user, router, isReady]);

  const { data, error, isLoading, mutate } = useSWR<PlanResponse>(user ? ['plan', bundleId] : null, () => fetcher(bundleId));
  const [busy, setBusy] = useState(false);

  const intentPolicyMap = useMemo(() => {
    const map = new Map<number, PlanResponse['policy']['intents'][number]>();
    if (data) {
      for (const decision of data.policy.intents) {
        map.set(decision.index, decision);
      }
    }
    return map;
  }, [data]);

  const policyState = useMemo(() => {
    if (!data) {
      return { canCommit: false, needsApproval: false };
    }
    const needsApproval = data.policy.requiresApproval && !data.approval;
    const canCommit = data.policy.allowed && !needsApproval;
    return { canCommit, needsApproval };
  }, [data]);

  const handleApprove = async () => {
    if (!bundleId || !user) {
      return;
    }
    setBusy(true);
    try {
      await approveBundle(bundleId, user);
      addToast('Bundle approved', 'success');
      await mutate();
    } catch (approveError) {
      addToast((approveError as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleCommit = async () => {
    if (!bundleId) {
      return;
    }
    setBusy(true);
    try {
      await commitBundle(bundleId);
      addToast('Bundle committed', 'success');
      await mutate();
    } catch (commitError) {
      addToast((commitError as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleRevert = async () => {
    if (!bundleId) {
      return;
    }
    setBusy(true);
    try {
      await revertBundle(bundleId);
      addToast('Bundle reverted', 'success');
      await mutate();
    } catch (revertError) {
      addToast((revertError as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return <p className="alert error">Failed to load bundle: {error.message}</p>;
  }

  if (isLoading || !data) {
    return <p>Loading bundle…</p>;
  }

  const status = data.status;

  return (
    <div>
      <div className="summary-grid">
        <div className="summary-card">
          <h4>Bundle ID</h4>
          <p>{data.bundleId}</p>
        </div>
        <div className="summary-card">
          <h4>Created</h4>
          <p>{new Date(data.createdAt).toLocaleString()}</p>
        </div>
        <div className="summary-card">
          <h4>Status</h4>
          <p>
            <span className={`badge ${status}`}>{status}</span>
          </p>
        </div>
        <div className="summary-card">
          <h4>Policy</h4>
          <p>{data.policy.policyVersion}</p>
        </div>
      </div>

      {data.policy.reasons.length > 0 && (
        <div className="alert error">
          <strong>Policy Warnings:</strong>
          <ul>
            {data.policy.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      {policyState.needsApproval && (
        <div className="alert warning">Human approval required for this bundle.</div>
      )}

      <div className="button-row">
        <button type="button" onClick={handleApprove} disabled={busy || !user || status === 'committed'} className="secondary">
          Approve
        </button>
        <button type="button" onClick={handleCommit} disabled={busy || !policyState.canCommit || status === 'committed'}>
          Commit
        </button>
        <button type="button" onClick={handleRevert} disabled={busy || status !== 'committed'} className="secondary">
          Revert
        </button>
      </div>

      <div className="tabs">
        <button
          type="button"
          className={activeTab === 'intents' ? 'active' : ''}
          onClick={() => setActiveTab('intents')}
        >
          Intents
        </button>
        <button type="button" className={activeTab === 'fs' ? 'active' : ''} onClick={() => setActiveTab('fs')}>
          Filesystem Diff
        </button>
        <button
          type="button"
          className={activeTab === 'network' ? 'active' : ''}
          onClick={() => setActiveTab('network')}
        >
          Network
        </button>
        <button
          type="button"
          className={activeTab === 'prompts' ? 'active' : ''}
          onClick={() => setActiveTab('prompts')}
        >
          Prompts
        </button>
      </div>

      {activeTab === 'intents' && (
        <div className="card">
          <h2>Intents</h2>
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Type</th>
                <th>Timestamp</th>
                <th>Policy</th>
                <th>Approval</th>
                <th>Rollback</th>
              </tr>
            </thead>
            <tbody>
              {data.intents.map((intent, index) => {
                const decision = intentPolicyMap.get(index);
                return (
                  <tr key={intent.id}>
                    <td>{intent.id}</td>
                    <td>{intent.type}</td>
                    <td>{intent.timestamp ? new Date(intent.timestamp).toLocaleString() : '—'}</td>
                    <td>
                      {decision ? (
                        <div>
                          <strong>{decision.allowed ? 'allowed' : 'blocked'}</strong>
                          {decision.reasons.length > 0 && (
                            <ul>
                              {decision.reasons.map((reason) => (
                                <li key={reason}>{reason}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {decision ? (
                        <div>
                          <strong>{decision.requiresApproval ? 'required' : 'not required'}</strong>
                          {decision.approvalReasons.length > 0 && (
                            <ul>
                              {decision.approvalReasons.map((reason) => (
                                <li key={reason}>{reason}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{renderRollbackCell(intent)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="intent-previews">
            {data.intents.map((intent) => (
              <div key={intent.id} className="intent-preview">
                <h3>
                  {intent.type} · {intent.id}
                </h3>
                {renderIntentPreview(intent)}
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'fs' && (
        <div className="card">
          <h2>Filesystem Changes</h2>
          <FsDiffViewer changed={data.fsDiff.changed} deleted={data.fsDiff.deleted} />
        </div>
      )}

      {activeTab === 'network' && (
        <div className="card">
          <h2>Network Activity</h2>
          <NetworkViewer entries={data.policy.network} har={data.networkHar} />
        </div>
      )}

      {activeTab === 'prompts' && (
        <div className="card">
          <h2>Prompts</h2>
          {data.prompts.length > 0 ? <PromptsViewer prompts={data.prompts} /> : <p>No prompts recorded.</p>}
        </div>
      )}
    </div>
  );
}

function renderRollbackCell(intent: PlanIntentSummary): JSX.Element | string {
  if (!intent.rollback) {
    return '—';
  }

  if (!intent.rollback.available) {
    return 'not available';
  }

  const ruleSummary = intent.rollback.rule ? `rule: ${intent.rollback.rule}` : 'registry match';
  const idInfo = intent.rollback.requiresId ? 'requires id' : 'no id required';
  return (
    <div className="muted">
      <strong>available</strong>
      <div>{ruleSummary}</div>
      <div>{idInfo}</div>
    </div>
  );
}

function renderIntentPreview(intent: PlanIntentSummary): JSX.Element {
  switch (intent.type) {
    case 'email.send':
      return renderEmailPreview(intent);
    case 'calendar.event':
      return renderCalendarPreview(intent);
    default:
      return renderGenericPreview(intent);
  }
}

function renderEmailPreview(intent: PlanIntentSummary): JSX.Element {
  const payload = (intent.payload ?? {}) as Record<string, unknown>;
  const to = formatRecipientList(payload.to);
  const cc = formatRecipientList(payload.cc);
  const bcc = formatRecipientList(payload.bcc);
  const subject = typeof payload.subject === 'string' ? payload.subject : '(no subject)';
  const text = typeof payload.bodyText === 'string' ? payload.bodyText : undefined;
  const html = typeof payload.bodyHtml === 'string' ? payload.bodyHtml : undefined;
  const body = text ?? (html ? stripHtml(html) : '(no body)');

  const rows: PreviewRow[] = [
    { label: 'Subject', value: subject },
    { label: 'To', value: to }
  ];

  if (cc) {
    rows.push({ label: 'CC', value: cc });
  }
  if (bcc) {
    rows.push({ label: 'BCC', value: bcc });
  }

  rows.push({ label: 'Body', value: body, muted: true });

  addLabelRows(rows, intent);
  addRollbackRows(rows, intent);

  return renderPreviewList(rows);
}

function renderCalendarPreview(intent: PlanIntentSummary): JSX.Element {
  const payload = (intent.payload ?? {}) as Record<string, unknown>;
  const title = typeof payload.title === 'string' ? payload.title : '(untitled event)';
  const start = typeof payload.start === 'string' ? formatDateTime(payload.start, payload.timezone) : '(start unknown)';
  const end = typeof payload.end === 'string' ? formatDateTime(payload.end, payload.timezone) : '(end unknown)';
  const attendees = formatRecipientList(payload.attendees);
  const location = typeof payload.location === 'string' ? payload.location : undefined;
  const description = typeof payload.description === 'string' ? payload.description : undefined;

  const rows: PreviewRow[] = [
    { label: 'Title', value: title },
    { label: 'Starts', value: start },
    { label: 'Ends', value: end },
    { label: 'Attendees', value: attendees }
  ];

  if (location) {
    rows.push({ label: 'Location', value: location });
  }
  if (description) {
    rows.push({ label: 'Description', value: description, muted: true });
  }

  addLabelRows(rows, intent);
  addRollbackRows(rows, intent);

  return renderPreviewList(rows);
}

function renderGenericPreview(intent: PlanIntentSummary): JSX.Element {
  const rows: PreviewRow[] = [];
  addLabelRows(rows, intent);
  addRollbackRows(rows, intent);
  return (
    <div>
      {rows.length > 0 && renderPreviewList(rows)}
      <pre>{JSON.stringify(intent.payload ?? {}, null, 2)}</pre>
    </div>
  );
}

function formatRecipientList(value: unknown): string {
  const list = toStringArray(value);
  if (list.length === 0) {
    return '—';
  }
  return list.join(', ');
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, '').trim();
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function formatDateTime(value: string, timezone: unknown): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const tz = typeof timezone === 'string' ? timezone : 'UTC';
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: tz
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

interface PreviewRow {
  label: string;
  value: string;
  muted?: boolean;
}

function renderPreviewList(rows: PreviewRow[]): JSX.Element {
  return (
    <ul className="preview-list">
      {rows.map((row, index) => (
        <li key={`${row.label}-${index}`} className={row.muted ? 'muted' : undefined}>
          <strong>{row.label}:</strong> <span>{row.value}</span>
        </li>
      ))}
    </ul>
  );
}

function addLabelRows(rows: PreviewRow[], intent: PlanIntentSummary): void {
  const metadata = (intent.metadata ?? {}) as Record<string, unknown>;
  const labels = toStringArray(metadata.labels);
  if (labels.length > 0) {
    rows.push({ label: 'Labels', value: labels.join(', ') });
  }
}

function addRollbackRows(rows: PreviewRow[], intent: PlanIntentSummary): void {
  const rollback = intent.rollback;
  if (!rollback || !rollback.available) {
    return;
  }
  const rule = rollback.rule ? `Rule: ${rollback.rule}` : 'Registry rule matched';
  const idInfo = rollback.requiresId ? 'Requires resource identifier' : 'No identifier required';
  rows.push({ label: 'Rollback', value: `${rule} · ${idInfo}`, muted: true });
}
