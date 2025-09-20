export interface TraceEvent {
  readonly timestamp: number;
  readonly channel: string;
  readonly data: unknown;
}

export interface TraceBundle {
  readonly id: string;
  readonly events: readonly TraceEvent[];
}

export function serializeTrace(bundle: TraceBundle): string {
  return JSON.stringify(bundle);
}

export function parseTrace(payload: string): TraceBundle {
  const bundle = JSON.parse(payload) as TraceBundle;
  if (!bundle.id || !Array.isArray(bundle.events)) {
    throw new Error('Invalid trace payload');
  }

  return bundle;
}
