const RECOVERY_INTERVAL_MS = 600_000;
const NETWORK_RETRY_BASE_MS = 5_000;
const NETWORK_RETRY_MAX_MS = 300_000;
const HOURLY_RECOVERY_FAILURE_THRESHOLD = 10;
const HOURLY_RECOVERY_INTERVAL_MS = 3_600_000;
const LOCK_RETRY_MS = 1_000;
const RESET_BUFFER_MS = 60_000;

function quotaRecoveryDelay({ now, waitUntil, stateResetAt, retryAt, delay, hasData, failures, backoff }) {
  if (retryAt > now) return retryAt - now;
  if (delay !== undefined) return delay;
  const reset = Math.min(...[waitUntil, stateResetAt].map((time) =>
    Number.isFinite(time) && time > 0 && time + RESET_BUFFER_MS > now ? time : Infinity));
  if (hasData) return Number.isFinite(reset) ? reset + RESET_BUFFER_MS - now : undefined;
  if (failures >= HOURLY_RECOVERY_FAILURE_THRESHOLD) return HOURLY_RECOVERY_INTERVAL_MS;
  return Number.isFinite(reset) ? reset + RESET_BUFFER_MS - now : backoff;
}
