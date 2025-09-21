'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { useEffect, useRef, useState } from 'react';
import { fetchBundles, uploadBundle } from '../../lib/api';
import type { BundleSummary } from '../../lib/types';
import { useAuth } from '../../components/auth-context';
import { useToast } from '../../components/toast-context';

const fetcher = async () => fetchBundles();

export default function BundlesPage() {
  const router = useRouter();
  const { user, isReady } = useAuth();
  const { addToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  useEffect(() => {
    if (isReady && !user) {
      router.replace('/login');
    }
  }, [user, router, isReady]);

  const { data, error, isLoading, mutate } = useSWR<BundleSummary[]>(user ? 'bundles' : null, fetcher, {
    refreshInterval: 10_000
  });

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setIsUploading(true);
    try {
      const response = await uploadBundle(file);
      addToast(`Bundle ${response.bundleId} uploaded`, 'success');
      await mutate();
    } catch (uploadError) {
      addToast((uploadError as Error).message, 'error');
    } finally {
      setIsUploading(false);
      event.target.value = '';
    }
  };

  const bundles = data ?? [];

  return (
    <div>
      <div className="card">
        <h1>Bundles</h1>
        <p>Review deterministic bundles before promoting changes.</p>
        <div className="button-row">
          <button type="button" onClick={handleUploadClick} disabled={isUploading}>
            {isUploading ? 'Uploading…' : 'Upload Bundle'}
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".tgz"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
        {error && <p className="alert error">Failed to load bundles: {error.message}</p>}
        {isLoading && bundles.length === 0 && <p>Loading…</p>}
        {bundles.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Created</th>
                <th>Status</th>
                <th>Approval</th>
              </tr>
            </thead>
            <tbody>
              {bundles.map((bundle) => (
                <tr key={bundle.id} onClick={() => router.push(`/bundles/${bundle.id}`)}>
                  <td>
                    <Link href={`/bundles/${bundle.id}`} prefetch={false}>
                      {bundle.id}
                    </Link>
                  </td>
                  <td>{new Date(bundle.createdAt).toLocaleString()}</td>
                  <td>
                    <span className={`badge ${bundle.status}`}>{bundle.status}</span>
                  </td>
                  <td>{bundle.approval ? `${bundle.approval.actor} (${bundle.approval.policyVersion})` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          !isLoading && <p>No bundles uploaded yet.</p>
        )}
      </div>
    </div>
  );
}
