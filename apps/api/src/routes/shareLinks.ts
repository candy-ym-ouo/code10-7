import { Router } from 'express';
import { createShareLinkSchema } from '@heirloom/shared';
import { asyncHandler } from '../http/asyncHandler';
import { clientMeta, currentUser } from '../middleware/auth';
import { familyCtx, requireFamily } from '../middleware/family';
import { writeLimiter } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validation';
import * as shareService from '../services/shareService';

export const shareLinksRouter = Router({ mergeParams: true });

shareLinksRouter.post(
  '/',
  requireFamily('share:manage'),
  writeLimiter,
  validateBody(createShareLinkSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const link = await shareService.createShareLink(user.id, ctx, req.body, clientMeta(req));
    res.status(201).json({ shareLink: link });
  }),
);

shareLinksRouter.get(
  '/',
  requireFamily('share:manage'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json({ shareLinks: await shareService.listShareLinks(ctx) });
  }),
);

shareLinksRouter.get(
  '/:linkId',
  requireFamily('share:manage'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json(await shareService.getShareLinkDetail(ctx, req.params.linkId!));
  }),
);

shareLinksRouter.delete(
  '/:linkId',
  requireFamily('share:manage'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    await shareService.revokeShareLink(user.id, ctx, req.params.linkId!, clientMeta(req));
    res.status(204).end();
  }),
);

// 条目级单独失效：不删链接，只摘掉这一个条目（内容与媒体同时对访客 404）
shareLinksRouter.delete(
  '/:linkId/items/:itemId',
  requireFamily('share:manage'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    await shareService.removeShareLinkItem(
      user.id,
      ctx,
      req.params.linkId!,
      req.params.itemId!,
      clientMeta(req),
    );
    res.status(204).end();
  }),
);

// 恢复被单独摘掉的条目
shareLinksRouter.post(
  '/:linkId/items/:itemId/restore',
  requireFamily('share:manage'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    await shareService.restoreShareLinkItem(
      user.id,
      ctx,
      req.params.linkId!,
      req.params.itemId!,
      clientMeta(req),
    );
    res.status(204).end();
  }),
);
