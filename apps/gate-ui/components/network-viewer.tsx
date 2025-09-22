'use client';

import { useState } from 'react';
import type { PolicyEvaluation } from '../lib/types';

interface NetworkViewerProps {
  readonly entries: PolicyEvaluation['network'];
  readonly har?: string | null;
}

export function NetworkViewer({ entries, har }: NetworkViewerProps) {
  const [showHar, setShowHar] = useState(false);
  return (
    <div className="network-viewer">
      {entries.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Method</th>
              <th>URL</th>
              <th>Allowed</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={`${entry.method}-${entry.url}`}>
                <td>{entry.method}</td>
                <td>{entry.url}</td>
                <td>{entry.allowed ? 'allowed' : 'blocked'}</td>
                <td>
                  {entry.reasons.length > 0 ? (
                    <ul>
                      {entry.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No outbound requests recorded.</p>
      )}
      {har && (
        <div className="har-toggle">
          <button type="button" onClick={() => setShowHar((value) => !value)}>
            {showHar ? 'Hide HAR' : 'Show HAR'}
          </button>
          {showHar && (
            <pre className="har-view">{har}</pre>
          )}
        </div>
      )}
    </div>
  );
}
