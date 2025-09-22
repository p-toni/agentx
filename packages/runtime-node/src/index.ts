import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

type ExecutionMode = 'record' | 'replay';

type TimerCallback = (...args: unknown[]) => void;

type TimerType = 'timeout' | 'interval';

interface InstallOptions {
  clockFile?: string;
}

interface ClockFile {
  version: number;
  initialTime: string;
  sources: Record<string, unknown> & {
    node?: NodeClockSource;
  };
}

interface NodeClockSource {
  ticks: NodeClockTick[];
  recordedAt: string;
  mode: ExecutionMode;
}

interface NodeClockTick {
  sequence: number;
  at: number;
  type: TimerType;
  delay: number;
  timerId: number;
  interval?: number;
}

interface SchedulerContext {
  baseMs: number;
  recordedTicks?: NodeClockTick[];
}

interface TimerEntry {
  id: number;
  type: TimerType;
  callback: TimerCallback;
  args: unknown[];
  delay: number;
  interval?: number;
  dueTime: number;
  active: boolean;
  sequence: number;
}

const INSTALL_SYMBOL = Symbol.for('deterministic-agent-lab/runtime-node-installed');
const TIMER_ID_SYMBOL = Symbol.for('deterministic-agent-lab/runtime-node-timer');
const nativeSetImmediate = setImmediate;

function createSeededRng(seed: number): () => number {
  let state = (seed >>> 0) || 1;

  return () => {
    state = (1664525 * state + 1013904223) % 0x100000000;
    return state / 0x100000000;
  };
}

export function installDeterministicRuntime(options?: InstallOptions): void {
  if ((globalThis as Record<PropertyKey, unknown>)[INSTALL_SYMBOL]) {
    return;
  }

  (globalThis as Record<PropertyKey, unknown>)[INSTALL_SYMBOL] = true;

  if (!isDeterministicEnabled()) {
    return;
  }

  const mode = normaliseMode(process.env.AGENT_EXECUTION_MODE);
  const clockFilePath = resolveClockFile(options?.clockFile);
  const startTimeIso = process.env.AGENT_START_TIME ?? new Date().toISOString();
  const baseMs = normaliseStartTime(startTimeIso);
  const recordedTicks = mode === 'replay' ? loadNodeTicks(clockFilePath) : undefined;

  const scheduler = new DeterministicScheduler({ baseMs, recordedTicks });

  patchTimers(scheduler);
  patchClock(scheduler);
  patchRandom();

  registerPersist(clockFilePath, startTimeIso, mode, scheduler);
}

function patchRandom(): void {
  const seedRaw = process.env.AGENT_SEED;
  if (!seedRaw) {
    return;
  }

  const seed = Number.parseInt(seedRaw, 10);
  if (!Number.isFinite(seed)) {
    return;
  }

  const rng = createSeededRng(seed);
  Math.random = rng;
}

function patchClock(scheduler: DeterministicScheduler): void {
  const OriginalDate = Date;
  const originalDateNow = Date.now.bind(Date);
  const baseMs = scheduler.getBaseMs();

  const now = () => scheduler.now();
  Date.now = now;

  type DateCtorArg = ConstructorParameters<typeof OriginalDate>[number];

  class DeterministicDate extends OriginalDate {
    constructor(...args: DateCtorArg[]) {
      if (args.length === 0) {
        super(now());
      } else {
        super(...(args as ConstructorParameters<typeof OriginalDate>));
      }
    }

    static now(): number {
      return now();
    }
  }

  (globalThis as { Date: DateConstructor }).Date = DeterministicDate as unknown as DateConstructor;

  if (globalThis.performance && typeof globalThis.performance.now === 'function') {
    const origin = Number.isFinite(globalThis.performance.timeOrigin)
      ? globalThis.performance.timeOrigin
      : baseMs;
    globalThis.performance.now = () => scheduler.now() - origin;
  }

  process.once('exit', () => {
    Date.now = originalDateNow;
    (globalThis as { Date: DateConstructor }).Date = OriginalDate;
  });
}

function patchTimers(scheduler: DeterministicScheduler): void {
  const originalSetTimeout = global.setTimeout.bind(global);
  const originalSetInterval = global.setInterval.bind(global);
  const originalClearTimeout = global.clearTimeout.bind(global);
  const originalClearInterval = global.clearInterval.bind(global);

  global.setTimeout = ((callback: TimerCallback | string, delay?: number, ...args: unknown[]) => {
    const timer = toTimerCallback(callback);
    return scheduler.setTimer('timeout', timer, delay, args);
  }) as typeof setTimeout;

  global.setInterval = ((callback: TimerCallback | string, delay?: number, ...args: unknown[]) => {
    const timer = toTimerCallback(callback);
    return scheduler.setTimer('interval', timer, delay, args);
  }) as typeof setInterval;

  global.clearTimeout = ((handle?: NodeJS.Timeout | number | null) => {
    scheduler.clearTimer(handle);
  }) as typeof clearTimeout;

  global.clearInterval = ((handle?: NodeJS.Timeout | number | null) => {
    scheduler.clearTimer(handle);
  }) as typeof clearInterval;

  process.once('exit', () => {
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
    global.clearTimeout = originalClearTimeout;
    global.clearInterval = originalClearInterval;
  });
}

function toTimerCallback(callback: TimerCallback | string): TimerCallback {
  if (typeof callback === 'function') {
    return callback;
  }

  const source = String(callback);
  return () => {
    // eslint-disable-next-line no-new-func
    const fn = new Function(source) as TimerCallback;
    fn();
  };
}

function registerPersist(
  clockFilePath: string,
  startTimeIso: string,
  mode: ExecutionMode,
  scheduler: DeterministicScheduler
): void {
  let persisted = false;
  const writeClock = () => {
    if (persisted) {
      return;
    }
    persisted = true;

    try {
      const ticks = scheduler.getTicks();
      persistClock(clockFilePath, startTimeIso, mode, ticks);
    } catch (error) {
      process.stderr.write(
        `[dal-runtime-node] failed to persist deterministic clock: ${(error as Error).message}\n`
      );
    }
  };

  process.once('exit', writeClock);
  process.once('SIGINT', () => {
    writeClock();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    writeClock();
    process.exit(143);
  });
}

function persistClock(
  clockFilePath: string,
  startTimeIso: string,
  mode: ExecutionMode,
  ticks: NodeClockTick[]
): void {
  const existing = loadClockFile(clockFilePath);
  const clock: ClockFile = {
    version: 1,
    initialTime: existing?.initialTime ?? startTimeIso,
    sources: {
      ...(existing?.sources ?? {}),
      node: {
        ticks: ticks.map((tick) => ({ ...tick })),
        recordedAt: new Date().toISOString(),
        mode
      }
    }
  };

  const output = JSON.stringify(clock, null, 2);
  mkdirSync(dirname(clockFilePath), { recursive: true });
  writeFileSync(clockFilePath, `${output}\n`, 'utf8');
}

function loadClockFile(clockFilePath: string): ClockFile | undefined {
  if (!existsSync(clockFilePath)) {
    return undefined;
  }

  try {
    const raw = readFileSync(clockFilePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ClockFile>;
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }

    const initialTime = typeof parsed.initialTime === 'string' ? parsed.initialTime : new Date().toISOString();
    const sources = (parsed.sources && typeof parsed.sources === 'object') ? parsed.sources : {};

    const clock: ClockFile = {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      initialTime,
      sources: sources as ClockFile['sources']
    };

    return clock;
  } catch (error) {
    process.stderr.write(
      `[dal-runtime-node] failed to read clock file ${clockFilePath}: ${(error as Error).message}\n`
    );
    return undefined;
  }
}

function loadNodeTicks(clockFilePath: string): NodeClockTick[] | undefined {
  const file = loadClockFile(clockFilePath);
  if (!file?.sources?.node) {
    return undefined;
  }

  const ticks = file.sources.node.ticks;
  if (!Array.isArray(ticks)) {
    return undefined;
  }

  return ticks
    .filter((tick): tick is NodeClockTick => validateTick(tick))
    .map((tick, index) => ({
      sequence: typeof tick.sequence === 'number' ? tick.sequence : index,
      at: tick.at,
      type: tick.type,
      delay: tick.delay,
      timerId: tick.timerId,
      interval: tick.interval
    }))
    .sort((left, right) => left.sequence - right.sequence);
}

function validateTick(tick: unknown): tick is NodeClockTick {
  if (!tick || typeof tick !== 'object') {
    return false;
  }

  const record = tick as Record<string, unknown>;
  return (
    (record.type === 'timeout' || record.type === 'interval') &&
    typeof record.at === 'number' &&
    typeof record.delay === 'number' &&
    typeof record.timerId === 'number'
  );
}

function resolveClockFile(explicit?: string): string {
  if (explicit) {
    return resolve(explicit);
  }

  if (process.env.AGENT_CLOCK_FILE) {
    return resolve(process.env.AGENT_CLOCK_FILE);
  }

  return resolve(process.cwd(), '.agent/clock.json');
}

function normaliseStartTime(startTimeIso: string): number {
  const value = Date.parse(startTimeIso);
  if (Number.isFinite(value)) {
    return value;
  }
  return Date.now();
}

function normaliseMode(value?: string): ExecutionMode {
  return value?.toLowerCase() === 'replay' ? 'replay' : 'record';
}

function isDeterministicEnabled(): boolean {
  const flag = process.env.AGENT_DETERMINISTIC;
  if (!flag) {
    return false;
  }
  return flag === '1' || flag.toLowerCase?.() === 'true';
}

class TimerHandle implements NodeJS.Timeout {
  readonly [TIMER_ID_SYMBOL]: number;

  constructor(private readonly scheduler: DeterministicScheduler, private readonly entry: TimerEntry) {
    this[TIMER_ID_SYMBOL] = entry.id;
  }

  hasRef(): boolean {
    return true;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  refresh(): this {
    this.scheduler.refreshTimer(this.entry);
    return this;
  }

  [Symbol.dispose](): void {
    this.scheduler.clearTimer(this);
  }

  [Symbol.asyncDispose](): Promise<void> {
    this.scheduler.clearTimer(this);
    return Promise.resolve();
  }

  [Symbol.toPrimitive](): number {
    return this.entry.id;
  }
}

class DeterministicScheduler {
  private readonly queue: TimerEntry[] = [];
  private readonly handles = new Map<number, TimerEntry>();
  private readonly producedTicks: NodeClockTick[] = [];
  private readonly recordedTicks?: NodeClockTick[];
  private nextId = 1;
  private nextSequence = 1;
  private flushScheduled = false;
  private virtualNow: number;
  private recordedIndex = 0;

  constructor(private readonly context: SchedulerContext) {
    this.virtualNow = context.baseMs;
    this.recordedTicks = context.recordedTicks?.map((tick) => ({ ...tick }));
  }

  getBaseMs(): number {
    return this.context.baseMs;
  }

  now(): number {
    return this.virtualNow;
  }

  getTicks(): NodeClockTick[] {
    return this.producedTicks.map((tick) => ({ ...tick }));
  }

  setTimer(
    type: TimerType,
    callback: TimerCallback,
    delayValue: unknown,
    args: unknown[]
  ): NodeJS.Timeout {
    const delay = this.normaliseDelay(delayValue);
    const interval = type === 'interval' ? Math.max(1, delay || 0) : undefined;

    const entry: TimerEntry = {
      id: this.nextId++,
      type,
      callback,
      args,
      delay,
      interval,
      dueTime: this.virtualNow + (interval ?? delay),
      active: true,
      sequence: this.nextSequence++
    };

    this.queue.push(entry);
    this.handles.set(entry.id, entry);
    this.scheduleFlush();
    return new TimerHandle(this, entry);
  }

  clearTimer(handle?: NodeJS.Timeout | number | null): void {
    const entry = this.resolveEntry(handle);
    if (!entry) {
      return;
    }

    entry.active = false;
    this.handles.delete(entry.id);
  }

  refreshTimer(entry: TimerEntry): void {
    if (!entry.active) {
      return;
    }

    entry.dueTime = this.virtualNow + (entry.interval ?? entry.delay);
    entry.sequence = this.nextSequence++;
    this.scheduleFlush();
  }

  private resolveEntry(handle?: NodeJS.Timeout | number | null): TimerEntry | undefined {
    if (handle === null || handle === undefined) {
      return undefined;
    }

    if (typeof handle === 'number') {
      return this.handles.get(handle);
    }

    const record = handle as unknown as Record<PropertyKey, unknown>;
    if (typeof record[TIMER_ID_SYMBOL] === 'number') {
      return this.handles.get(record[TIMER_ID_SYMBOL] as number);
    }

    return undefined;
  }

  private normaliseDelay(value: unknown): number {
    const numberValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numberValue) || numberValue < 0) {
      return 0;
    }
    return numberValue;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) {
      return;
    }

    this.flushScheduled = true;
    nativeSetImmediate(() => this.flushQueue());
  }

  private flushQueue(): void {
    this.flushScheduled = false;
    if (this.queue.length === 0) {
      return;
    }

    this.queue.sort((left, right) => {
      if (left.dueTime === right.dueTime) {
        return left.sequence - right.sequence;
      }
      return left.dueTime - right.dueTime;
    });

    while (this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) {
        break;
      }
      if (!entry.active) {
        continue;
      }

      if (this.recordedTicks) {
        const tick = this.recordedTicks[this.recordedIndex];
        if (!tick) {
          throw new Error(
            '[dal-runtime-node] replay exceeded recorded timer ticks; ensure the recorded schedule matches the current run'
          );
        }
        this.virtualNow = this.context.baseMs + tick.at;
        if (tick.type !== entry.type) {
          process.stderr.write(
            `[dal-runtime-node] timer type mismatch: expected ${tick.type} but encountered ${entry.type}\n`
          );
        }
        this.recordedIndex += 1;
      } else {
        this.virtualNow = Math.max(this.virtualNow, entry.dueTime);
      }

      const tick: NodeClockTick = {
        sequence: this.producedTicks.length,
        at: this.virtualNow - this.context.baseMs,
        type: entry.type,
        delay: entry.delay,
        timerId: entry.id
      };

      if (entry.type === 'interval' && entry.interval !== undefined) {
        tick.interval = entry.interval;
      }

      this.producedTicks.push(tick);

      try {
        entry.callback(...entry.args);
      } catch (error) {
        nativeSetImmediate(() => {
          throw error;
        });
      }

      if (entry.type === 'interval' && entry.active) {
        const intervalMs = entry.interval ?? (entry.delay || 1);
        entry.dueTime = this.virtualNow + intervalMs;
        entry.sequence = this.nextSequence++;
        this.queue.push(entry);
        this.queue.sort((left, right) => {
          if (left.dueTime === right.dueTime) {
            return left.sequence - right.sequence;
          }
          return left.dueTime - right.dueTime;
        });

        if (entry.dueTime <= this.virtualNow) {
          this.scheduleFlush();
          break;
        }

        continue;
      }

      entry.active = false;
      this.handles.delete(entry.id);
    }

    if (this.queue.length > 0) {
      this.scheduleFlush();
    }
  }
}

export type { InstallOptions };
