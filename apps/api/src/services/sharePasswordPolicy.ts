/**
 * 分享链接访问密码的错误次数限制策略（纯逻辑，方便单测）。
 * 连续输错 PASSWORD_MAX_FAILURES 次后锁定 PASSWORD_LOCK_MS 毫秒；
 * 锁定期内即使密码正确也拒绝，锁定期满自动重置计数。
 */
export const PASSWORD_MAX_FAILURES = 5;
export const PASSWORD_LOCK_MS = 15 * 60 * 1000;

export interface PasswordGateState {
  failCount: number;
  lockedUntil: Date | null;
}

/** 当前是否处于锁定状态。 */
export function isLockedOut(state: PasswordGateState, now: number = Date.now()): boolean {
  return Boolean(state.lockedUntil && state.lockedUntil.getTime() > now);
}

/** 剩余锁定秒数（向上取整，最小 1），未锁定时返回 0。 */
export function lockRemainingSeconds(state: PasswordGateState, now: number = Date.now()): number {
  if (!state.lockedUntil) return 0;
  const ms = state.lockedUntil.getTime() - now;
  return ms > 0 ? Math.max(1, Math.ceil(ms / 1000)) : 0;
}

/** 一次失败后的新状态：达到阈值则进入锁定，否则只累加计数。 */
export function registerFailure(
  state: PasswordGateState,
  now: number = Date.now(),
): PasswordGateState & { locked: boolean } {
  // 已经在锁定期内：只累加计数，不延长锁定时间
  if (isLockedOut(state, now)) {
    return { failCount: state.failCount + 1, lockedUntil: state.lockedUntil, locked: true };
  }
  // 上一轮锁定已过期：计数清零，按第一次失败重新计
  const base = state.lockedUntil ? 0 : state.failCount;
  const failCount = base + 1;
  if (failCount >= PASSWORD_MAX_FAILURES) {
    return { failCount, lockedUntil: new Date(now + PASSWORD_LOCK_MS), locked: true };
  }
  return { failCount, lockedUntil: null, locked: false };
}

/** 密码正确后清空计数与锁定标记。 */
export function resetFailures(): PasswordGateState {
  return { failCount: 0, lockedUntil: null };
}

/** 锁定期满后对外展示的计数：锁定过期时应视作 0。 */
export function effectiveFailures(state: PasswordGateState, now: number = Date.now()): number {
  return isLockedOut(state, now) ? state.failCount : state.lockedUntil && state.lockedUntil.getTime() <= now ? 0 : state.failCount;
}
