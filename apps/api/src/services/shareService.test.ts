import { beforeEach, describe, expect, it, vi } from 'vitest';

// 不连真实数据库：把 prisma 客户端整体替换成可控的 mock
const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  accessCreate: vi.fn(),
}));

vi.mock('../db', () => ({
  prisma: {
    shareLink: { findUnique: mocks.findUnique, update: mocks.update },
    item: { findMany: mocks.findMany },
    itemMedia: { findFirst: mocks.findFirst },
    shareAccess: { create: mocks.accessCreate },
  },
}));

vi.mock('./auditService', () => ({ record: vi.fn() }));

// 跳过密码哈希的真实 argon2 计算，直接按约定返回
vi.mock('./authService', () => ({
  hashPassword: async (p: string) => `hash:${p}`,
  verifyPassword: async (p: string, hash: string) => hash === `hash:${p}`,
}));

import { AppError } from '../http/errors';
import * as shareService from './shareService';

const { mockFindUnique, mockFindMany, mockFindFirst, mockUpdate } = {
  mockFindUnique: mocks.findUnique,
  mockFindMany: mocks.findMany,
  mockFindFirst: mocks.findFirst,
  mockUpdate: mocks.update,
};

const baseLink = (overrides: Record<string, unknown> = {}) => ({
  id: 'link1',
  familyId: 'fam1',
  tokenHash: 'x',
  passwordHash: null,
  label: null,
  expiresAt: new Date(Date.now() + 86_400_000),
  revokedAt: null,
  accessCount: 0,
  lastAccessAt: null,
  passwordFailCount: 0,
  lockedUntil: null,
  createdBy: 'u1',
  createdAt: new Date(),
  family: { id: 'fam1', name: '我家' },
  ...overrides,
});

const meta = { ip: '1.2.3.4', userAgent: 'vitest' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accessCreate.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
});

describe('viewShareLink 密码错误次数限制', () => {
  it('连续错误 5 次后返回锁定错误，之后即使密码正确也被拒', async () => {
    // 用可变对象模拟数据库，让失败计数在多次调用间累积
    const linkState = baseLink({ passwordHash: 'hash:secret' }) as Record<string, unknown>;
    mockFindUnique.mockImplementation(async () => linkState);
    mockUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(linkState, data);
    });
    mockFindMany.mockResolvedValue([]);

    for (let i = 1; i <= 4; i++) {
      const err = await shareService.viewShareLink('token', 'wrong', meta).catch((e) => e as AppError);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('UNAUTHENTICATED');
      expect((err as AppError).details).toMatchObject({ remaining: 5 - i });
    }
    expect(linkState.passwordFailCount).toBe(4);

    // 第 5 次：进入锁定，返回 RATE_LIMITED，且锁定已写入「数据库」
    const lockedErr = await shareService.viewShareLink('token', 'wrong', meta).catch((e) => e as AppError);
    expect(lockedErr).toBeInstanceOf(AppError);
    expect((lockedErr as AppError).code).toBe('RATE_LIMITED');
    expect(linkState.passwordFailCount).toBe(5);
    expect(linkState.lockedUntil).toBeInstanceOf(Date);

    // 锁定后用「正确」密码再试：应同样被挡住
    const stillLocked = await shareService.viewShareLink('token', 'secret', meta).catch((e) => e as AppError);
    expect(stillLocked).toBeInstanceOf(AppError);
    expect((stillLocked as AppError).code).toBe('RATE_LIMITED');
    // 锁定期内不允许返回任何条目
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('无需密码的链接不写入失败计数', async () => {
    mockFindUnique.mockResolvedValue(baseLink());
    mockFindMany.mockResolvedValue([]);
    const view = await shareService.viewShareLink('token', undefined, meta);
    expect(view.requiresPassword).toBe(false);
    expect(mockUpdate).toHaveBeenCalledTimes(1); // 只有 accessCount 更新
  });
});

describe('assertPublicMedia 三重阻断', () => {
  beforeEach(() => {
    mockFindUnique.mockResolvedValue(baseLink());
  });

  it('撤销 / 过期的链接直接 404，不查媒体', async () => {
    mockFindUnique.mockResolvedValue(baseLink({ revokedAt: new Date() }));
    await expect(shareService.assertPublicMedia('t', 'm1', meta)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockFindFirst).not.toHaveBeenCalled();

    mockFindUnique.mockResolvedValue(baseLink({ expiresAt: new Date(Date.now() - 1000) }));
    await expect(shareService.assertPublicMedia('t', 'm1', meta)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('查询媒体时同时校验：媒体未删除 + 条目未删除/未回收站 + 链接关联未被单独摘掉', async () => {
    mockFindFirst.mockResolvedValue(null);
    await expect(shareService.assertPublicMedia('t', 'm1', meta)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const where = mockFindFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: 'm1', deletedAt: null });
    expect(where.item).toMatchObject({
      deletedAt: null,
      status: { not: 'trashed' },
      shareLinks: { some: { shareLinkId: 'link1', removedAt: null } },
    });
  });

  it('raw/download 变体记录访问明细，thumb/waveform 由路由层选择不记录', async () => {
    const mediaRow = { id: 'm1', itemId: 'i1', originalName: 'a.jpg' };
    mockFindFirst.mockResolvedValue(mediaRow);
    const result = await shareService.assertPublicMedia('t', 'm1', meta, { record: true });
    expect(result).toBe(mediaRow);
    expect(mocks.accessCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'media', outcome: 'ok', itemId: 'i1', mediaId: 'm1' }),
      }),
    );
  });
});
