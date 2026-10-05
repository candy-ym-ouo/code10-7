import type { Prisma, ShareAccessEvent } from '@prisma/client';
import { prisma } from '../db';
import { AppError, notFound, unauthenticated } from '../http/errors';
import { randomToken, sha256Hex } from '../utils/crypto';
import { hashPassword, verifyPassword } from './authService';
import * as audit from './auditService';
import { toItemDto, toShareLinkDto } from '../serializers';
import { itemWithAccess, type FamilyContext } from './permissionService';

export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** 密码连续错误达到上限后，链接临时锁定的时长（分钟）。 */
const PASSWORD_LOCK_MINUTES = 30;
/** 触发锁定的连续密码错误次数。 */
const MAX_PASSWORD_FAILURES = 5;
/** 每条链接保留的访问明细节流上限，防止被恶意刷爆。 */
const ACCESS_LOG_KEEP = 500;

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
      include: { items: { include: { item: { select: { id: true, title: true, status: true, deletedAt: true } } } } },
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

export async function listShareLinks(ctx: FamilyContext) {
  const links = await prisma.shareLink.findMany({
    where: { familyId: ctx.familyId },
    include: { items: { include: { item: { select: { id: true, title: true, status: true, deletedAt: true } } } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return links.map((l) => toShareLinkDto(l));
}

export async function revokeShareLink(actorId: string, ctx: FamilyContext, linkId: string, meta: ActorMeta) {
  const link = await prisma.shareLink.findFirst({ where: { id: linkId, familyId: ctx.familyId } });
  if (!link) throw notFound('分享链接不存在');
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

/** 按条目单独失效：把某条记录从分享链接中移除，内容与媒体立即对该链接不可见。 */
export async function removeShareLinkItem(
  actorId: string,
  ctx: FamilyContext,
  linkId: string,
  itemId: string,
  meta: ActorMeta,
) {
  const link = await prisma.shareLink.findFirst({ where: { id: linkId, familyId: ctx.familyId } });
  if (!link) throw notFound('分享链接不存在');
  const row = await prisma.shareLinkItem.findUnique({
    where: { shareLinkId_itemId: { shareLinkId: linkId, itemId } },
  });
  if (!row) throw notFound('该条目不在此分享链接中');

  await prisma.$transaction(async (tx) => {
    await tx.shareLinkItem.delete({ where: { shareLinkId_itemId: { shareLinkId: linkId, itemId } } });
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
  });
}

/** 解除密码锁定：让被临时锁定的链接立即恢复可用。 */
export async function unlockShareLink(actorId: string, ctx: FamilyContext, linkId: string, meta: ActorMeta) {
  const link = await prisma.shareLink.findFirst({ where: { id: linkId, familyId: ctx.familyId } });
  if (!link) throw notFound('分享链接不存在');
  await prisma.$transaction(async (tx) => {
    await tx.shareLink.update({ where: { id: linkId }, data: { passwordFailures: 0, lockedUntil: null } });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'share.unlock',
        targetType: 'share_link',
        targetId: linkId,
        ...meta,
      },
      tx,
    );
  });
}

/** 访问明细：最近 100 条，倒序。 */
export async function listShareLinkAccesses(ctx: FamilyContext, linkId: string) {
  const link = await prisma.shareLink.findFirst({ where: { id: linkId, familyId: ctx.familyId } });
  if (!link) throw notFound('分享链接不存在');
  const rows = await prisma.shareLinkAccess.findMany({
    where: { shareLinkId: linkId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 100,
  });
  return rows.map((a) => ({
    id: a.id,
    event: a.event,
    itemCount: a.itemCount,
    ip: a.ip,
    userAgent: a.userAgent,
    createdAt: a.createdAt.toISOString(),
  }));
}

export interface PublicShareView {
  familyName: string;
  label: string | null;
  expiresAt: string;
  requiresPassword: boolean;
  lockedUntil: string | null;
  items: ReturnType<typeof toItemDto>[];
}

/**
 * 加载链接并校验可访问性。撤销、过期、家庭已删除三种情况在此集中阻断：
 * 内容（viewShareLink）与媒体（assertPublicMedia）都走这里，保证同时失效。
 */
async function loadLink(token: string) {
  const link = await prisma.shareLink.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { family: { select: { id: true, name: true, deletedAt: true } } },
  });
  if (!link) throw notFound('分享链接不存在或已被撤销');
  if (link.family.deletedAt) throw notFound('分享链接已被撤销');
  if (link.revokedAt) throw notFound('分享链接已被撤销');
  if (link.expiresAt.getTime() < Date.now()) throw notFound('分享链接已过期');
  return link;
}

/** 记录一条访问明细，并把该链接的明细裁剪到上限以内。 */
async function recordAccess(
  tx: Prisma.TransactionClient,
  shareLinkId: string,
  event: ShareAccessEvent,
  itemCount: number,
  meta: ActorMeta,
) {
  await tx.shareLinkAccess.create({
    data: {
      shareLinkId,
      event,
      itemCount,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    },
  });
  const excess = await tx.shareLinkAccess.findMany({
    where: { shareLinkId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: ACCESS_LOG_KEEP,
    select: { id: true },
  });
  if (excess.length > 0) {
    await tx.shareLinkAccess.deleteMany({ where: { id: { in: excess.map((a) => a.id) } } });
  }
}

function lockMessage(lockedUntil: Date): string {
  const minutes = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 60_000));
  return `密码尝试次数过多，链接已临时锁定，请 ${minutes} 分钟后再试`;
}

export async function viewShareLink(token: string, password: string | undefined, meta: ActorMeta): Promise<PublicShareView> {
  const link = await loadLink(token);

  if (link.passwordHash) {
    // 锁定期内拒绝一切密码尝试（含正确密码），防止爆破；家庭管理员可在设置里提前解锁
    if (link.lockedUntil && link.lockedUntil.getTime() > Date.now()) {
      if (!password) {
        return {
          familyName: link.family.name,
          label: link.label,
          expiresAt: link.expiresAt.toISOString(),
          requiresPassword: true,
          lockedUntil: link.lockedUntil.toISOString(),
          items: [],
        };
      }
      throw new AppError('RATE_LIMITED', lockMessage(link.lockedUntil));
    }
    if (!password) {
      return {
        familyName: link.family.name,
        label: link.label,
        expiresAt: link.expiresAt.toISOString(),
        requiresPassword: true,
        lockedUntil: null,
        items: [],
      };
    }
    const ok = await verifyPassword(password, link.passwordHash);
    if (!ok) {
      const failures = link.passwordFailures + 1;
      const lockedUntil =
        failures >= MAX_PASSWORD_FAILURES ? new Date(Date.now() + PASSWORD_LOCK_MINUTES * 60_000) : null;
      await prisma.$transaction(async (tx) => {
        await tx.shareLink.update({
          where: { id: link.id },
          data: { passwordFailures: lockedUntil ? 0 : failures, lockedUntil: lockedUntil ?? null },
        });
        await recordAccess(tx, link.id, lockedUntil ? 'password_locked' : 'password_fail', 0, meta);
      });
      throw unauthenticated(lockedUntil ? '密码错误次数过多，链接已临时锁定' : '访问密码不正确');
    }
    // 密码正确：重置失败计数与锁定状态
    if (link.passwordFailures > 0 || link.lockedUntil) {
      await prisma.shareLink.update({
        where: { id: link.id },
        data: { passwordFailures: 0, lockedUntil: null },
      });
    }
  }

  const rows = await prisma.item.findMany({
    where: { shareLinks: { some: { shareLinkId: link.id } }, deletedAt: null, status: { not: 'trashed' } },
    include: {
      media: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
      people: { include: { person: true } },
      _count: { select: { notes: true, media: true } },
    },
    orderBy: { sortAt: 'desc' },
  });

  await prisma.$transaction(async (tx) => {
    await tx.shareLink.update({
      where: { id: link.id },
      data: { accessCount: { increment: 1 }, lastAccessAt: new Date() },
    });
    await recordAccess(tx, link.id, 'view', rows.length, meta);
  });

  return {
    familyName: link.family.name,
    label: link.label,
    expiresAt: link.expiresAt.toISOString(),
    requiresPassword: false,
    lockedUntil: null,
    items: rows.map((r) => toItemDto(r, link.familyId)),
  };
}

/**
 * 访客读媒体：必须证明该媒体属于本链接覆盖的条目，且条目本身仍可访问。
 * 条目被删除/移入回收站、被移出链接，或链接被撤销/过期时，媒体与内容同时被阻断。
 */
export async function assertPublicMedia(token: string, mediaId: string) {
  const link = await loadLink(token);
  const media = await prisma.itemMedia.findFirst({
    where: {
      id: mediaId,
      deletedAt: null,
      item: {
        deletedAt: null,
        status: { not: 'trashed' },
        shareLinks: { some: { shareLinkId: link.id } },
      },
    },
  });
  if (!media) throw notFound('媒体不存在');
  return media;
}
