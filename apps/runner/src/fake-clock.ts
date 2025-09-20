export function installFakeClock(): void {
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
  class FakeDate extends OriginalDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      if (args.length === 0) {
        super(Date.now());
      } else {
        super(...args);
      }
    }
    static now() {
      return Date.now();
    }
  }
  global.Date = FakeDate as DateConstructor;

  if (global.performance && typeof global.performance.now === 'function') {
    const startPerf = global.performance.now();
    global.performance.now = () => startPerf + (Date.now() - baseMs);
  }

  process.on('exit', () => {
    Date.now = originalDateNow;
    global.Date = OriginalDate;
  });
}
