import { describe, expect, it } from 'vitest';
import {
  effectiveFailures,
  isLockedOut,
  lockRemainingSeconds,
  registerFailure,
  resetFailures,
  PASSWORD_MAX_FAILURES,
  PASSWORD_LOCK_MS,
} from './sharePasswordPolicy';

const T0 = 1_000_000_000_000;

describe('sharePasswordPolicy', () => {
  it('前几次失败只累加计数，不锁定', () => {
    let s = { failCount: 0, lockedUntil: null };
    for (let i = 1; i < PASSWORD_MAX_FAILURES; i++) {
      const next = registerFailure(s, T0);
      expect(next.locked).toBe(false);
      expect(next.lockedUntil).toBeNull();
      expect(next.failCount).toBe(i);
      s = next;
    }
    expect(isLockedOut(s, T0)).toBe(false);
  });

  it('连续错误达到阈值后锁定 15 分钟', () => {
    let s = { failCount: PASSWORD_MAX_FAILURES - 1, lockedUntil: null };
    const next = registerFailure(s, T0);
    expect(next.locked).toBe(true);
    expect(next.lockedUntil?.getTime()).toBe(T0 + PASSWORD_LOCK_MS);
    expect(isLockedOut(next, T0)).toBe(true);
    // 锁定期内剩余秒数向下界对齐，至少 1 秒
    expect(lockRemainingSeconds(next, T0)).toBe(PASSWORD_LOCK_MS / 1000);
  });

  it('锁定期内不会因为新的失败而延长或重置', () => {
    const locked = { failCount: PASSWORD_MAX_FAILURES, lockedUntil: new Date(T0 + PASSWORD_LOCK_MS) };
    const next = registerFailure(locked, T0 + 1000);
    expect(next.locked).toBe(true);
    expect(next.failCount).toBe(PASSWORD_MAX_FAILURES + 1);
    // 锁定时刻不变
    expect(next.lockedUntil?.getTime()).toBe(T0 + PASSWORD_LOCK_MS);
  });

  it('锁定期满后再次失败，计数重新开始', () => {
    const expired = { failCount: PASSWORD_MAX_FAILURES, lockedUntil: new Date(T0) };
    expect(isLockedOut(expired, T0 + 1)).toBe(false);
    expect(effectiveFailures(expired, T0 + 1)).toBe(0);
    const next = registerFailure(expired, T0 + 1);
    expect(next.failCount).toBe(1);
    expect(next.locked).toBe(false);
  });

  it('密码正确后计数与锁定都清空', () => {
    const cleared = resetFailures();
    expect(cleared).toEqual({ failCount: 0, lockedUntil: null });
  });
});
