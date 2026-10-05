import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Button, Spinner, Tag } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { formatDateTime } from '../../lib/format';
import type { ShareAccess, ShareLink, ShareLinkDetail } from '../../api/types';

const ACCESS_LABELS: Record<string, string> = {
  ok: '成功',
  denied_password: '密码错误',
  locked: '已锁定',
};

function AccessRow({ a }: { a: ShareAccess }) {
  const tone = a.outcome === 'ok' ? 'success' : 'warn';
  const target =
    a.kind === 'media'
      ? `读取媒体${a.itemTitle ? `（${a.itemTitle}）` : ''}`
      : `浏览「${a.itemTitle ?? '已删除条目'}」`;
  return (
    <div className="log-item">
      <div className="log-item__body">
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <Tag tone="muted">{a.kind === 'media' ? '媒体' : '浏览'}</Tag>
          <span>{target}</span>
          <Tag tone={tone}>{ACCESS_LABELS[a.outcome] ?? a.outcome}</Tag>
        </div>
        <div className="log-item__meta">
          {formatDateTime(a.createdAt)}
          {a.ip ? ` · ${a.ip}` : ''}
          {a.userAgent ? ` · ${a.userAgent.slice(0, 80)}` : ''}
        </div>
      </div>
    </div>
  );
}

function ShareLinkPanel({ fid, link }: { fid: string; link: ShareLink }) {
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const expired = new Date(link.expiresAt).getTime() < Date.now();
  const active = !link.revokedAt && !expired;
  const locked = link.lockedUntil && new Date(link.lockedUntil).getTime() > Date.now();

  const detail = useQuery({
    queryKey: ['share-link-detail', fid, link.id],
    queryFn: () => api.get<ShareLinkDetail>(`/families/${fid}/share-links/${link.id}`),
    enabled: open,
  });

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['share-links', fid] }),
      queryClient.invalidateQueries({ queryKey: ['share-link-detail', fid, link.id] }),
    ]);

  const revoke = useMutation({
    mutationFn: () => api.del(`/families/${fid}/share-links/${link.id}`),
    onSuccess: async () => {
      push('分享链接已撤销，内容与媒体均已对访客关闭', 'success');
      await invalidate();
    },
  });

  const removeItem = useMutation({
    mutationFn: (itemId: string) => api.del(`/families/${fid}/share-links/${link.id}/items/${itemId}`),
    onSuccess: async () => {
      push('该条目已从分享中移除，访客端内容与媒体同时失效', 'success');
      await invalidate();
    },
  });

  const restoreItem = useMutation({
    mutationFn: (itemId: string) => api.post(`/families/${fid}/share-links/${link.id}/items/${itemId}/restore`),
    onSuccess: async () => {
      push('已恢复该条目的分享', 'success');
      await invalidate();
    },
  });

  return (
    <div className="log-item" style={{ flexWrap: 'wrap' }}>
      <div className="log-item__body">
        <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            style={{ fontWeight: 600, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit' }}
          >
            {link.label || '未命名分享'} {open ? '▾' : '▸'}
          </button>
          {link.hasPassword ? <Tag>有密码</Tag> : null}
          {locked ? <Tag tone="warn">密码锁定中</Tag> : null}
          {active ? <Tag tone="success">有效</Tag> : <Tag tone="muted">{link.revokedAt ? '已撤销' : '已过期'}</Tag>}
          {typeof link.activeItemCount === 'number' && typeof link.itemCount === 'number' ? (
            <Tag tone="muted">
              {link.activeItemCount}/{link.itemCount} 条有效
            </Tag>
          ) : null}
        </div>
        <div className="log-item__meta">
          访问 {link.accessCount} 次 · 有效期至 {formatDateTime(link.expiresAt)}
          {link.lastAccessAt ? ` · 最近 ${formatDateTime(link.lastAccessAt)}` : ''}
          {locked ? ` · 密码锁定至 ${formatDateTime(link.lockedUntil!)}` : ''}
        </div>
      </div>
      {active ? (
        <Button size="sm" onClick={() => revoke.mutate()}>
          撤销
        </Button>
      ) : null}

      {open ? (
        <div style={{ flexBasis: '100%', marginTop: 'var(--space-3)' }}>
          {detail.isLoading ? (
            <Spinner />
          ) : detail.data ? (
            <>
              <h3 style={{ marginBottom: 'var(--space-2)' }}>链接内条目（近 30 天访问）</h3>
              <div className="log-list" style={{ marginBottom: 'var(--space-4)' }}>
                {detail.data.items.map((it) => (
                  <div key={it.itemId} className="log-item">
                    <div className="log-item__body">
                      <div className="row" style={{ gap: 'var(--space-2)' }}>
                        <span>{it.title}</span>
                        {it.trashed ? <Tag tone="warn">条目已删除/回收站</Tag> : null}
                        {it.removedAt ? <Tag tone="muted">已从分享移除</Tag> : null}
                      </div>
                      <div className="log-item__meta">
                        浏览 {it.viewCount30d} 次 · 媒体读取 {it.mediaCount30d} 次
                        {it.removedAt ? ` · 移除于 ${formatDateTime(it.removedAt)}` : ''}
                      </div>
                    </div>
                    {active && !it.trashed ? (
                      it.removedAt ? (
                        <Button size="sm" variant="ghost" loading={restoreItem.isPending} onClick={() => restoreItem.mutate(it.itemId)}>
                          恢复
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" loading={removeItem.isPending} onClick={() => removeItem.mutate(it.itemId)}>
                          单独移除
                        </Button>
                      )
                    ) : null}
                  </div>
                ))}
              </div>

              <h3 style={{ marginBottom: 'var(--space-2)' }}>访问明细（最近 200 条）</h3>
              {detail.data.accesses.length === 0 ? (
                <p className="muted">还没有人访问过。</p>
              ) : (
                <div className="log-list">
                  {detail.data.accesses.map((a) => (
                    <AccessRow key={a.id} a={a} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="field__error">加载失败，请稍后重试。</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ShareLinksManager({ fid }: { fid: string }) {
  const shareLinks = useQuery({
    queryKey: ['share-links', fid],
    queryFn: () => api.get<{ shareLinks: ShareLink[] }>(`/families/${fid}/share-links`),
    enabled: Boolean(fid),
  });

  if (shareLinks.isLoading) return <Spinner />;

  const links = shareLinks.data?.shareLinks ?? [];
  if (links.length === 0) {
    return <p className="muted">还没有分享过内容。打开某个条目，点「分享」即可生成链接。</p>;
  }

  return (
    <div className="log-list">
      {links.map((link) => (
        <ShareLinkPanel key={link.id} fid={fid!} link={link} />
      ))}
    </div>
  );
}
