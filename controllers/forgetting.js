const COLD_START_MASTERY = 0.3;
const DEFAULT_TAU_DAYS = 14;

const toDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string') {
    const head = value.trim().split(' ')[0];
    if (!head) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(head);
    if (!m) return null;
    const d = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
};

const daysSince = (lastSeen, today) => {
  const ls = toDate(lastSeen);
  if (!ls) return null;
  const t = toDate(today) ?? new Date();
  const diff = Math.floor((t.getTime() - ls.getTime()) / (24 * 60 * 60 * 1000));
  return Math.max(0, diff);
};

const forgettingScore = (
  mastery,
  lastSeenDaysAgo,
  tau = DEFAULT_TAU_DAYS,
) => {
  if (lastSeenDaysAgo === null || lastSeenDaysAgo <= 0) return 0.0;
  const m = Math.max(0, Math.min(1, mastery));
  const dt = lastSeenDaysAgo;
  const score = ((1 - m) * dt) / (dt + tau);
  return Math.round(score * 1000) / 1000;
};

module.exports = { COLD_START_MASTERY, DEFAULT_TAU_DAYS, daysSince, forgettingScore };