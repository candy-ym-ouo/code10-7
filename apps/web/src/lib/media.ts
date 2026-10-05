import { api, getAccessToken } from '../api/client';
import type { Media } from '../api/types';

/**
 * 把服务端返回的媒体地址转成 <img>/<audio> 能直接用的地址。
 * 令牌以查询参数附上（服务端只对 GET 媒体路径放行），这样音频能走原生 Range 流式播放。
 */
export function mediaSrc(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  // 公开分享地址用链接本身鉴权，绝不能把家庭成员的 access token 拼上去
  if (url.includes('/public/')) return url;
  const token = getAccessToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
}

export interface WaveformData {
  peaks: number[];
  sampleRate: number;
  durationMs: number | null;
}

export async function fetchWaveform(media: Media): Promise<WaveformData | null> {
  if (!media.waveformUrl) return null;
  try {
    // 公开分享的波形地址没有登录态，直接 fetch（带鉴权头反而会被 CORS/CSRF 拒）
    if (media.waveformUrl.includes('/public/')) {
      const res = await fetch(media.waveformUrl);
      if (!res.ok) return null;
      return (await res.json()) as WaveformData;
    }
    return await api.absolute<WaveformData>(media.waveformUrl);
  } catch {
    return null;
  }
}

export function isPlayableInBrowser(mimeType: string): boolean {
  return /audio\/(mpeg|mp4|wav|webm|ogg)/.test(mimeType);
}

