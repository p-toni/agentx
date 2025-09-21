'use client';

import { useState } from 'react';
import type { PromptRecord } from '../lib/types';

interface PromptsViewerProps {
  readonly prompts: PromptRecord[];
}

export function PromptsViewer({ prompts }: PromptsViewerProps) {
  const [selected, setSelected] = useState<PromptRecord | null>(prompts[0] ?? null);
  return (
    <div className="prompts-viewer">
      <aside>
        <ul>
          {prompts.map((prompt) => (
            <li key={prompt.name}>
              <button
                type="button"
                className={selected?.name === prompt.name ? 'active' : ''}
                onClick={() => setSelected(prompt)}
              >
                {prompt.name}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section>
        {selected ? <pre>{selected.content}</pre> : <p>No prompt selected.</p>}
      </section>
    </div>
  );
}
