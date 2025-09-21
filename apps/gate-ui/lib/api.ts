import type {
  ActionResponse,
  BundleSummary,
  PlanResponse,
  UploadResponse
} from './types';

const API_BASE = process.env.NEXT_PUBLIC_GATE_API_URL ?? 'http://127.0.0.1:3001';

async function gateFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  if (init?.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers
  });

  if (!res.ok) {
    const message = await safeErrorMessage(res);
    throw new Error(message);
  }

  if (res.status === 204) {
    return undefined as unknown as T;
  }

  return (await res.json()) as T;
}

async function safeErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body?.error) {
      return body.error as string;
    }
  } catch {
    // ignore
  }
  return `Request failed with status ${res.status}`;
}

export async function fetchBundles(): Promise<BundleSummary[]> {
  const payload = await gateFetch<{ bundles: BundleSummary[] }>('/bundles');
  return payload.bundles;
}

export async function fetchBundlePlan(id: string): Promise<PlanResponse> {
  return gateFetch<PlanResponse>(`/bundles/${id}/plan`);
}

export async function uploadBundle(file: File): Promise<UploadResponse> {
  const arrayBuffer = await file.arrayBuffer();
  const base64 = bufferToBase64(arrayBuffer);
  return gateFetch<UploadResponse>('/bundles', {
    method: 'POST',
    body: JSON.stringify({ bundle: base64 })
  });
}

export async function approveBundle(bundleId: string, actor: string): Promise<ActionResponse> {
  return gateFetch<ActionResponse>(`/bundles/${bundleId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ actor })
  });
}

export async function commitBundle(bundleId: string): Promise<ActionResponse> {
  return gateFetch<ActionResponse>(`/bundles/${bundleId}/commit`, {
    method: 'POST'
  });
}

export async function revertBundle(bundleId: string): Promise<ActionResponse> {
  return gateFetch<ActionResponse>(`/bundles/${bundleId}/revert`, {
    method: 'POST'
  });
}

function bufferToBase64(buffer: ArrayBuffer): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buffer).toString('base64');
  }

  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}
