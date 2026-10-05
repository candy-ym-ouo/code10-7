import { Router } from 'express';
import { asyncHandler } from '../http/asyncHandler';
import { clientMeta } from '../middleware/auth';
import { passwordLimiter, publicLimiter } from '../middleware/rateLimit';
import * as shareService from '../services/shareService';
import { mediaFileTarget } from '../services/mediaService';
import { sendStoredFile } from '../http/sendFile';
import { notFound } from '../http/errors';

export const publicRouter = Router();

publicRouter.post(
  '/share/:token',
  // 交密码（或试探）的入口单独限流，配合服务端的错误次数锁定一起防爆破
  passwordLimiter,
  asyncHandler(async (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : undefined;
    res.json({
      share: await shareService.viewShareLink(req.params.token!, password, clientMeta(req)),
    });
  }),
);

publicRouter.get(
  '/share/:token/media/:mediaId/:variant',
  publicLimiter,
  asyncHandler(async (req, res) => {
    const variant = req.params.variant!;
    if (!['raw', 'thumb', 'waveform', 'download'].includes(variant)) throw notFound('媒体不存在');
    // 缩略图/波形是同内容的派生产物，页面打开会批量请求，不重复记访问明细；
    // raw/download 代表真正取走文件，单独记录。
    const record = variant === 'raw' || variant === 'download';
    const media = await shareService.assertPublicMedia(req.params.token!, req.params.mediaId!, clientMeta(req), {
      record,
    });
    const target = await mediaFileTarget(media, variant as 'raw' | 'thumb' | 'waveform' | 'download');
    sendStoredFile(req, res, {
      key: target.key,
      size: target.size,
      mimeType: target.mimeType,
      filename: media.originalName,
      download: variant === 'download',
    });
  }),
);
