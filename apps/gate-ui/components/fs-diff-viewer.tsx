'use client';

import { useMemo, useState } from 'react';
import { diffLines } from 'diff';
import clsx from 'clsx';
import type { FileDiffEntry } from '../lib/types';

interface FsDiffViewerProps {
  readonly changed: FileDiffEntry[];
  readonly deleted: FileDiffEntry[];
}

const EMPTY_DIFF: FileDiffEntry[] = [];

export function FsDiffViewer({ changed, deleted }: FsDiffViewerProps) {
  const [selected, setSelected] = useState<FileDiffEntry | null>(changed[0] ?? deleted[0] ?? null);
  const changedList = changed ?? EMPTY_DIFF;
  const deletedList = deleted ?? EMPTY_DIFF;

  const diff = useMemo(() => {
    if (!selected) {
      return [];
    }
    const beforeText = selected.before?.isBinary ? '[binary]' : selected.before?.text ?? '';
    const afterText = selected.after?.isBinary ? '[binary]' : selected.after?.text ?? '';
    if (selected.before?.isBinary || selected.after?.isBinary) {
      return [];
    }
    return diffLines(beforeText, afterText);
  }, [selected]);

  return (
    <div className="fs-diff">
      <div className="fs-diff-sidebar">
        <h3>Changed Files</h3>
        <ul>
          {changedList.map((entry) => (
            <li key={`changed-${entry.path}`}>
              <button
                type="button"
                className={clsx({ active: selected?.path === entry.path })}
                onClick={() => setSelected(entry)}
              >
                {entry.path}
              </button>
            </li>
          ))}
        </ul>
        {deletedList.length > 0 && (
          <>
            <h3>Deleted</h3>
            <ul>
              {deletedList.map((entry) => (
                <li key={`deleted-${entry.path}`}>
                  <button
                    type="button"
                    className={clsx({ active: selected?.path === entry.path })}
                    onClick={() => setSelected(entry)}
                  >
                    {entry.path}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="fs-diff-content">
        {!selected && <p>Select a file to view the diff.</p>}
        {selected && selected.before?.isBinary && selected.after?.isBinary && <p>Binary file change.</p>}
        {selected && !selected.before?.isBinary && !selected.after?.isBinary && (
          <pre className="diff-view">
            {diff.map((part, index) => (
              <span
                key={`${part.added ? 'a' : part.removed ? 'r' : 's'}-${index}`}
                className={clsx({ added: part.added, removed: part.removed })}
              >
                {part.value}
              </span>
            ))}
          </pre>
        )}
        {selected && selected.before?.isBinary && !selected.after && <p>Removed binary file.</p>}
      </div>
    </div>
  );
}
