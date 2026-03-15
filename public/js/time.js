/**
 * time.js - Shared time helpers for round countdowns and JA display.
 */

const TimeUtil = (() => {
  const JA_TZ = "America/Jamaica";

  const jaTimeFmt = new Intl.DateTimeFormat("en-JM", {
    timeZone: JA_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const jaDateTimeFmt = new Intl.DateTimeFormat("en-JM", {
    timeZone: JA_TZ,
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  function parseIso(value) {
    if (!value) return null;
    const dt = new Date(value);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  function formatCountdown(sec) {
    const n = Math.max(0, Math.floor(sec));
    if (n >= 3600) {
      const h = Math.floor(n / 3600);
      const m = String(Math.floor((n % 3600) / 60)).padStart(2, "0");
      const s = String(n % 60).padStart(2, "0");
      return `${h}:${m}:${s}`;
    }
    const m = String(Math.floor(n / 60)).padStart(2, "0");
    const s = String(n % 60).padStart(2, "0");
    return `${m}:${s}`;
  }

  function secondsUntil(target, nowMs = Date.now()) {
    if (!target) return 0;
    return Math.max(0, Math.floor((target.getTime() - nowMs) / 1000));
  }

  function getRoundPhase(round, nowMs = Date.now()) {
    const opensAt = parseIso(round?.opens_at);
    const closesAt = parseIso(round?.closes_at);
    const endsAt = parseIso(round?.ends_at);

    if (opensAt && nowMs < opensAt.getTime()) {
      return {
        badge: "UPCOMING",
        label: "Starts in",
        seconds: secondsUntil(opensAt, nowMs),
      };
    }
    if (closesAt && nowMs < closesAt.getTime()) {
      return {
        badge: "OPEN",
        label: "Bets close in",
        seconds: secondsUntil(closesAt, nowMs),
      };
    }
    if (endsAt && nowMs < endsAt.getTime()) {
      return {
        badge: "LOCKED",
        label: "Round ends in",
        seconds: secondsUntil(endsAt, nowMs),
      };
    }
    return { badge: "RESOLVING", label: "Resolving", seconds: 0 };
  }

  function formatJaTime(value) {
    const dt = value instanceof Date ? value : parseIso(value);
    return dt ? jaTimeFmt.format(dt) : "-";
  }

  function formatJaDateTime(value) {
    const dt = value instanceof Date ? value : parseIso(value);
    return dt ? jaDateTimeFmt.format(dt) : "-";
  }

  return {
    JA_TZ,
    parseIso,
    formatCountdown,
    getRoundPhase,
    formatJaTime,
    formatJaDateTime,
  };
})();

window.TimeUtil = TimeUtil;
