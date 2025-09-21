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
import type { PlanResponse } from '../../../lib/types';
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
              </tr>
            </thead>
            <tbody>
              {data.intents.map((intent) => (
                <tr key={intent.id}>
                  <td>{intent.id}</td>
                  <td>{intent.type}</td>
                  <td>{intent.timestamp ? new Date(intent.timestamp).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
