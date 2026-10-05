import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, EmptyState, Field, Spinner, Tag, TextInput } from '../../components/ui';
import { ImageGallery } from '../media/ImageGallery';
import { AudioPlayer } from '../media/AudioPlayer';
import { CATEGORY_ICONS, CATEGORY_LABELS } from '../../lib/constants';
import type { Item, Media } from '../../api/types';

interface ShareView {
  familyName: string;
  label: string | null;
  expiresAt: string;
  requiresPassword: boolean;
  locked?: boolean;
  lockedUntil?: string | null;
  items: Item[];
}

/**
 * 公开分享里的媒体不走登录令牌通道（访客本来就没有账号），
 * 把 toMediaDto 产出的家族内部媒体地址改写成公开地址。
 */
function withPublicMedia(item: Item, token: string): Item {
  return {
    ...item,
    media: item.media.map((m) => ({
      ...m,
      rawUrl: `/api/v1/public/share/${token}/media/${m.id}/download`,
      thumbUrl: m.hasThumb ? `/api/v1/public/share/${token}/media/${m.id}/thumb` : null,
      waveformUrl: m.hasWaveform ? `/api/v1/public/share/${token}/media/${m.id}/waveform` : null,
    })),
  };
}

export function ShareViewPage() {
  const { token } = useParams<{ token: string }>();
  const [password, setPassword] = useState('');
  const [view, setView] = useState<ShareView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = useMutation({
    mutationFn: (pwd?: string) =>
      api<{ share: ShareView }>(`/public/share/${token}`, {
        method: 'POST',
        body: pwd ? { password: pwd } : {},
        skipRetry: true,
      }),
    onSuccess: (data) => setView(data.share),
    onError: (err) => setError(err instanceof ApiError ? err.message : '打不开这个分享'),
  });

  // 首屏自动探测：这条分享是否需要密码
  const { mutate } = open;
  useEffect(() => {
    mutate(undefined);
    // 只在 token 变化时重新探测
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (open.isPending && !view) return <Spinner label="正在打开分享…" />;

  if (error && !view) {
    const locked = open.error instanceof ApiError && Boolean((open.error.details as { lockedUntil?: string } | undefined)?.lockedUntil);
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>{locked ? '分享已临时锁定' : '打不开这个分享'}</h1>
          <p className="muted" style={{ marginTop: 'var(--space-3)' }}>
            {error}
          </p>
        </div>
      </div>
    );
  }

  if (view?.requiresPassword) {
    const lockDetails = (open.error as ApiError | null)?.details as
      | { lockedUntil?: string; retryAfterSeconds?: number; remaining?: number }
      | undefined;
    const locked = Boolean(lockDetails?.lockedUntil);
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-card__head">
            <h1>{view.familyName}</h1>
            <p>这是家人分享给你的内容，需要输入访问密码。</p>
          </div>
          <Field label="访问密码" error={error} required>
            <TextInput
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setError(null);
                  open.mutate(password);
                }
              }}
              disabled={locked}
              autoFocus
            />
          </Field>
          {!locked && lockDetails && typeof lockDetails.remaining === 'number' ? (
            <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
              密码错误，还可以再试 {lockDetails.remaining} 次；连续错误过多链接会临时锁定。
            </p>
          ) : null}
          <Button
            variant="primary"
            loading={open.isPending}
            disabled={locked}
            onClick={() => {
              setError(null);
              open.mutate(password);
            }}
            style={{ width: '100%' }}
          >
            {locked ? '已锁定，请稍后再试' : '查看'}
          </Button>
        </div>
      </div>
    );
  }

  if (!view) return null;

  const items = view.items.map((it) => withPublicMedia(it, token!));

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__inner">
          <span className="brand">
            <span className="brand__mark" aria-hidden="true">
              册
            </span>
            <span>{view.familyName}</span>
          </span>
          <div style={{ flex: 1 }} />
          <Tag>只读分享</Tag>
        </div>
      </header>
      <main className="app-main">
        <div className="page-head">
          <div>
            <h1>{view.label || '家人分享给你的记录'}</h1>
            <p className="page-head__sub">共 {items.length} 条，链接有效期至 {new Date(view.expiresAt).toLocaleDateString('zh-CN')}</p>
          </div>
        </div>

        {items.length === 0 ? (
          <EmptyState title="没有可查看的内容" description="可能分享已经被撤销或内容已删除。" />
        ) : (
          <div className="stack">
            {items.map((item) => (
              <article key={item.id} className="card">
                <div className="row" style={{ gap: 'var(--space-2)', marginBottom: 6 }}>
                  <Tag>
                    {CATEGORY_ICONS[item.category]} {CATEGORY_LABELS[item.category]}
                  </Tag>
                  <Tag tone="muted">{item.acquiredDisplay}</Tag>
                </div>
                <h2 style={{ marginBottom: 'var(--space-2)' }}>{item.title}</h2>
                {item.placeText ? <p className="muted">{item.placeText}</p> : null}
                {item.storyHtml ? (
                  <div className="story" dangerouslySetInnerHTML={{ __html: item.storyHtml }} />
                ) : null}
                <ImageGallery media={item.media.filter((m): m is Media => m.kind === 'image')} />
                {item.media
                  .filter((m) => m.kind === 'audio')
                  .map((m) => (
                    <div key={m.id} style={{ marginTop: 'var(--space-3)' }}>
                      <AudioPlayer media={{ ...m, rawUrl: `/api/v1/public/share/${token}/media/${m.id}/download` }} />
                    </div>
                  ))}
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
