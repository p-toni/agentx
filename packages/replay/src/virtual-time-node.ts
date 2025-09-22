export function installVirtualClock(): void {
  const startTimeIso = process.env.AGENT_START_TIME;
  if (!startTimeIso) {
    return;
  }

  const baseMs = Date.parse(startTimeIso);
  if (Number.isNaN(baseMs)) {
    return;
  }

  const startHr = process.hrtime.bigint();
  const originalDateNow = Date.now.bind(Date);

  Date.now = () => {
    const elapsedNs = process.hrtime.bigint() - startHr;
    const elapsedMs = Number(elapsedNs / 1_000_000n);
    return baseMs + elapsedMs;
  };

  const OriginalDate = Date;
  type DateCtorArg = ConstructorParameters<typeof Date>[number];

  class FakeDate extends OriginalDate {
    constructor(...args: DateCtorArg[]) {
      if (args.length === 0) {
        super(Date.now());
      } else {
        super(...(args as ConstructorParameters<typeof Date>));
      }
    }

    static now() {
      return Date.now();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Date = FakeDate as DateConstructor;

  if (globalThis.performance && typeof globalThis.performance.now === 'function') {
    const startPerf = globalThis.performance.now();
    globalThis.performance.now = () => startPerf + (Date.now() - baseMs);
  }

  process.on('exit', () => {
    Date.now = originalDateNow;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Date = OriginalDate;
  });
}
