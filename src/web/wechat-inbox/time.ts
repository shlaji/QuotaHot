const relativeFormatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'always', style: 'short' });
const absoluteFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  fractionalSecondDigits: 3, hourCycle: 'h23', timeZoneName: 'short',
});
const units = [
  ['year', 365 * 86_400_000], ['month', 30 * 86_400_000], ['day', 86_400_000],
  ['hour', 3_600_000], ['minute', 60_000], ['second', 1_000],
] as const;

export function formatMessageTime(timestamp: string, now: number = Date.now()): {
  readonly relative: string;
  readonly absolute: string;
} {
  const instant = Date.parse(timestamp);
  if (!Number.isFinite(instant)) return { relative: '时间未知', absolute: timestamp };

  const difference = instant - now;
  const distance = Math.abs(difference);
  const absolute = absoluteFormatter.format(instant);
  if (difference <= 0 && distance < 60_000) return { relative: '刚刚', absolute };

  for (const [unit, milliseconds] of units) {
    if (distance >= milliseconds) {
      const value = Math.floor(distance / milliseconds) * Math.sign(difference);
      return { relative: relativeFormatter.format(value, unit), absolute };
    }
  }
  return { relative: relativeFormatter.format(1, 'second'), absolute };
}
