import type { Prisma, ShareAccessKind } from '@prisma/client';
import { prisma } from '../db';
import { logger } from '../logger';
import { AppError, notFound } from '../http/errors';
import { randomToken, sha256Hex } from '../utils/crypto';
import { hashPassword, verifyPassword } from './authService';
import * as audit from './auditService';
import { toItemDto, toShareLinkDto } from '../serializers';
import { itemWithAccess, type FamilyContext } from './permissionService';
import {
  isLockedOut,
  lockRemainingSeconds,
  registerFailure,
  resetFailures,
  PASSWORD_MAX_FAILURES,
} from './sharePasswordPolicy';
export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

interface PublicAccessInput {
  shareLinkId: string;
  kind: ShareAccessKind;
  outcome: string;
  itemId?: string | null;
  mediaId?: string | null;
  meta: ActorMeta;
}

/**
 * 公开访问明细。访客没有账号、无法写审计表（actorId 非空），
 * 因此单独落一张 share_accesses，失败也不阻断主流程（与 recordSoft 同思路）。
 */
export async function recordShareAccess(input: PublicAccessInput): Promise<void> {
  try {
    await prisma.shareAccess.create({
      data: {
        shareLinkId: input.shareLinkId,
        kind: input.kind,
        outcome: input.outcome,
        itemId: input.itemId ?? null,
        mediaId: input.mediaId ?? null,
        ip: input.meta.ip ?? null,
        userAgent: input.meta.userAgent ?? null,
      },
    });
  } catch (err) {
    logger.error({ err, outcome: input.outcome }, '分享访问明细写入失败');
  }
}

export async function createShareLink(
  userId: string,
  ctx: FamilyContext,
  input: { itemIds: string[]; expiresInDays: number; password?: string | null; label?: string | null },
  meta: ActorMeta,
) {
  // 只能分享自己有权看到的条目，避免借分享链接绕过可见性
  for (const itemId of input.itemIds) {
    await itemWithAccess(userId, ctx, itemId);
  }

  const token = randomToken(24);
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);

  const link = await prisma.$transaction(async (tx) => {
    const created = await tx.shareLink.create({
      data: {
        familyId: ctx.familyId,
        tokenHash: sha256Hex(token),
        passwordHash,
        label: input.label ?? null,
        expiresAt,
        createdBy: userId,
        items: { create: input.itemIds.map((itemId) => ({ itemId })) },
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'share.create',
        targetType: 'share_link',
        targetId: created.id,
        diff: { itemCount: input.itemIds.length, expiresAt: expiresAt.toISOString() } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return created;
  });

  return { ...toShareLinkDto(link, token), token };
}

/** 近 30 天每条链接、每个条目的成功浏览次数，用于管理页展示访问明细。 */
async function recentItemViewCounts(linkIds: string[], since: Date) {
  if (linkIds.length === 0) return new Map<string, number>();
  const rows = await prisma.shareAccess.groupBy({
    by: ['shareLinkId', 'itemId'],
    where: { shareLinkId: { in: linkIds }, kind: 'view', outcome: 'ok', createdAt: { gte: since }, itemId: { not: null } },
    _count: { _all: true },
  });
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.itemId) map.set(`${r.shareLinkId}:${r.itemId}`, r._count._all);
  }
  return map;
}

export async function listShareLinks(ctx: FamilyContext) {
  const links = await prisma.shareLink.findMany({
    where: { familyId: ctx.familyId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      items: {
        select: {
          itemId: true,
          removedAt: true,
          item: { select: { id: true, title: true, status: true, deletedAt: true } },
        },
      },
    },
  });
  const counts = await recentItemViewCounts(
    links.map((l) => l.id),
    new Date(Date.now() - 30 * 86_400_000),
  );

  return links.map((l) => ({
    ...toShareLinkDto(l),
    itemCount: l.items.length,
    activeItemCount: l.items.filter((it) => !it.removedAt).length,
    items: l.items.map((it) => ({
      itemId: it.itemId,
      title: it.item.title,
      status: it.item.status,
      trashed: it.item.status === 'trashed' || Boolean(it.item.deletedAt),
      removedAt: it.removedAt?.toISOString() ?? null,
      viewCount30d: counts.get(`${l.id}:${it.itemId}`) ?? 0,
    })),
  }));
}

async function loadManagedLink(ctx: FamilyContext, linkId: string) {
  const link = await prisma.shareLink.findFirst({ where: { id: linkId, familyId: ctx.familyId } });
  if (!link) throw notFound('分享链接不存在');
  return link;
}

export interface ShareLinkDetail {
  shareLink: ReturnType<typeof toShareLinkDto>;
  items: {
    itemId: string;
    title: string;
    status: string;
    trashed: boolean;
    removedAt: string | null;
    viewCount30d: number;
    mediaCount30d: number;
  }[];
  accesses: {
    id: string;
    kind: ShareAccessKind;
    outcome: string;
    itemId: string | null;
    itemTitle: string | null;
    mediaId: string | null;
    ip: string | null;
    userAgent: string | null;
    createdAt: string;
  }[];
}

export async function getShareLinkDetail(ctx: FamilyContext, linkId: string): Promise<ShareLinkDetail> {
  const link = await loadManagedLink(ctx, linkId);
  const since = new Date(Date.now() - 30 * 86_400_000);

  const [rows, itemViews, itemMedia] = await Promise.all([
    prisma.shareAccess.findMany({
      where: { shareLinkId: link.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { item: { select: { title: true } } },
    }),
    prisma.shareAccess.groupBy({
      by: ['itemId'],
      where: { shareLinkId: link.id, kind: 'view', outcome: 'ok', createdAt: { gte: since }, itemId: { not: null } },
      _count: { _all: true },
    }),
    prisma.shareAccess.groupBy({
      by: ['itemId'],
      where: { shareLinkId: link.id, kind: 'media', outcome: 'ok', createdAt: { gte: since }, itemId: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const links = await prisma.shareLinkItem.findMany({
    where: { shareLinkId: link.id },
    include: { item: { select: { title: true, status: true, deletedAt: true } } },
  });
  const viewCount = new Map(itemViews.filter((r) => r.itemId).map((r) => [r.itemId!, r._count._all]));
  const mediaCount = new Map(itemMedia.filter((r) => r.itemId).map((r) => [r.itemId!, r._count._all]));

  return {
    shareLink: { ...toShareLinkDto(link) },
    items: links.map((it) => ({
      itemId: it.itemId,
      title: it.item.title,
      status: it.item.status,
      trashed: it.item.status === 'trashed' || Boolean(it.item.deletedAt),
      removedAt: it.removedAt?.toISOString() ?? null,
      viewCount30d: viewCount.get(it.itemId) ?? 0,
      mediaCount30d: mediaCount.get(it.itemId) ?? 0,
    })),
    accesses: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      outcome: r.outcome,
      itemId: r.itemId,
      itemTitle: r.item?.title ?? null,
      mediaId: r.mediaId,
      ip: r.ip,
      userAgent: r.userAgent,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export async function revokeShareLink(actorId: string, ctx: FamilyContext, linkId: string, meta: ActorMeta) {
  await loadManagedLink(ctx, linkId);
  await prisma.$transaction(async (tx) => {
    await tx.shareLink.update({ where: { id: linkId }, data: { revokedAt: new Date() } });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'share.revoke',
        targetType: 'share_link',
        targetId: linkId,
        ...meta,
      },
      tx,
    );
  });
}

/**
 * 把单个条目从分享链接中摘掉（链接内单独失效）。
 * 软删除：保留关联与历史访问明细，访客侧的内容与媒体同时被查询条件挡掉。
 */
export async function removeShareLinkItem(
  actorId: string,
  ctx: FamilyContext,
  linkId: string,
  itemId: string,
  meta: ActorMeta,
) {
  await loadManagedLink(ctx, linkId);
  const row = await prisma.shareLinkItem.findUnique({
    where: { shareLinkId_itemId: { shareLinkId: linkId, itemId } },
  });
  if (!row) throw notFound('该条目不在此分享链接中');

  await prisma.$transaction(async (tx) => {
    await tx.shareLinkItem.update({
      where: { shareLinkId_itemId: { shareLinkId: linkId, itemId } },
      data: { removedAt: row.removedAt ?? new Date(), removedBy: actorId },
    });
    if (!row.removedAt) {
      await audit.record(
        {
          familyId: ctx.familyId,
          actorId,
          action: 'share.item_remove',
          targetType: 'share_link',
          targetId: linkId,
          diff: { itemId } as Prisma.InputJsonValue,
          ...meta,
        },
        tx,
      );
    }
  });
}

/** 恢复之前从链接中摘掉的条目（条目本身必须仍存在，彻底删除时关联行会被级联清掉）。 */
export async function restoreShareLinkItem(
  actorId: string,
  ctx: FamilyContext,
  linkId: string,
  itemId: string,
  meta: ActorMeta,
) {
  await loadManagedLink(ctx, linkId);
  const row = await prisma.shareLinkItem.findUnique({
    where: { shareLinkId_itemId: { shareLinkId: linkId, itemId } },
  });
  if (!row) throw notFound('该条目不在此分享链接中');

  await prisma.$transaction(async (tx) => {
    await tx.shareLinkItem.update({
      where: { shareLinkId_itemId: { shareLinkId: linkId, itemId } },
      data: { removedAt: null, removedBy: null },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'share.item_restore',
        targetType: 'share_link',
        targetId: linkId,
        diff: { itemId } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
  });
}

export interface PublicShareView {
  familyName: string;
  label: string | null;
  expiresAt: string;
  requiresPassword: boolean;
  locked?: boolean;
  lockedUntil?: string | null;
  items: ReturnType<typeof toItemDto>[];
}

async function loadLink(token: string) {
  const link = await prisma.shareLink.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { family: { select: { id: true, name: true } } },
  });
  if (!link) throw notFound('分享链接不存在或已被撤销');
  if (link.revokedAt) throw notFound('分享链接已被撤销');
  if (link.expiresAt.getTime() < Date.now()) throw notFound('分享链接已过期');
  return link;
}

/** 公开访客查询条目时的统一条件：链接覆盖 + 条目未被单独摘掉 + 条目未删除/未进回收站。 */
function publicItemsWhere(linkId: string): Prisma.ItemWhereInput {
  return {
    shareLinks: { some: { shareLinkId: linkId, removedAt: null } },
    deletedAt: null,
    status: { not: 'trashed' },
  };
}

function lockedError(lockedUntil: Date): AppError {
  const seconds = lockRemainingSeconds({ failCount: PASSWORD_MAX_FAILURES, lockedUntil });
  const mins = Math.ceil(seconds / 60);
  return new AppError(
    'RATE_LIMITED',
    `密码连续错误次数过多，为保护内容安全，链接已临时锁定，请 ${mins} 分钟后再试`,
    { lockedUntil: lockedUntil.toISOString(), retryAfterSeconds: seconds },
  );
}

export async function viewShareLink(token: string, password: string | undefined, meta: ActorMeta): Promise<PublicShareView> {
  const link = await loadLink(token);

  if (link.passwordHash) {
    const gate = { failCount: link.passwordFailCount, lockedUntil: link.lockedUntil };
    if (isLockedOut(gate)) {
      await recordShareAccess({ shareLinkId: link.id, kind: 'view', outcome: 'locked', meta });
      throw lockedError(link.lockedUntil!);
    }
    if (!password) {
      // 首屏探测：只告知需要密码，不返回任何条目内容
      return {
        familyName: link.family.name,
        label: link.label,
        expiresAt: link.expiresAt.toISOString(),
        requiresPassword: true,
        items: [],
      };
    }
    const ok = await verifyPassword(password, link.passwordHash);
    if (!ok) {
      const next = registerFailure({ failCount: link.passwordFailCount, lockedUntil: link.lockedUntil });
      await prisma.shareLink.update({
        where: { id: link.id },
        data: { passwordFailCount: next.failCount, lockedUntil: next.lockedUntil },
      });
      await recordShareAccess({ shareLinkId: link.id, kind: 'view', outcome: 'denied_password', meta });
      if (next.locked) {
        logger.warn({ linkId: link.id, ip: meta.ip }, '分享链接访问密码连续失败，已临时锁定');
        throw lockedError(next.lockedUntil!);
      }
      throw new AppError('UNAUTHENTICATED', '访问密码不正确', {
        remaining: PASSWORD_MAX_FAILURES - next.failCount,
      });
    }
    // 密码正确：清空历史失败计数（上一轮锁定已过期的情况也一并归零）
    if (link.passwordFailCount !== 0 || link.lockedUntil) {
      await prisma.shareLink.update({ where: { id: link.id }, data: resetFailures() });
    }
  }

  const rows = await prisma.item.findMany({
    where: publicItemsWhere(link.id),
    include: {
      media: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
      people: { include: { person: true } },
      _count: { select: { notes: true, media: true } },
    },
    orderBy: { sortAt: 'desc' },
  });

  await prisma.shareLink.update({
    where: { id: link.id },
    data: { accessCount: { increment: 1 }, lastAccessAt: new Date() },
  });
  // 每个可看条目落一条浏览明细；整体被撤销/过期时 loadLink 已先挡住，到不了这里
  await Promise.all(
    rows.map((r) =>
      recordShareAccess({ shareLinkId: link.id, kind: 'view', outcome: 'ok', itemId: r.id, meta }),
    ),
  );

  return {
    familyName: link.family.name,
    label: link.label,
    expiresAt: link.expiresAt.toISOString(),
    requiresPassword: false,
    items: rows.map((r) => toItemDto(r, link.familyId)),
  };
}

/**
 * 访客读媒体：必须同时证明
 *  1) 链接有效（未撤销、未过期）；
 *  2) 该媒体未删除；
 *  3) 媒体所属条目仍被链接覆盖、未被单独摘掉、条目本身未删除/未进回收站。
 * 任一条件不满足都返回 404，内容与媒体走同一道闸。
 */
export async function assertPublicMedia(
  token: string,
  mediaId: string,
  meta: ActorMeta,
  opts: { record?: boolean } = {},
) {
  const link = await loadLink(token);
  const media = await prisma.itemMedia.findFirst({
    where: {
      id: mediaId,
      deletedAt: null,
      item: {
        deletedAt: null,
        status: { not: 'trashed' },
        shareLinks: { some: { shareLinkId: link.id, removedAt: null } },
      },
    },
  });
  if (!media) throw notFound('媒体不存在');
  if (opts.record) {
    await recordShareAccess({
      shareLinkId: link.id,
      kind: 'media',
      outcome: 'ok',
      itemId: media.itemId,
      mediaId: media.id,
      meta,
    });
  }
  return media;
}
