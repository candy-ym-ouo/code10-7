import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, Spinner, Tag } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { formatDateTime } from '../../lib/format';
import type { ShareLink, ShareLinkAccess } from '../../api/types';

const EVENT_LABELS: Record<ShareLinkAccess['event'], string> = {
  view: '打开查看',
  password_fail: '密码错误',
  password_locked: '触发锁定',
};

function AccessList({ fid, linkId }: { fid: string; linkId: string }) {
  const accesses = useQuery({
    queryKey: ['share-link-accesses', fid, linkId],
    queryFn: () => api.get<{ accesses: ShareLinkAccess[] }>(`/families/${fid}/share-links/${linkId}/accesses`),
  });

  if (accesses.isPending) return <Spinner label="正在加载访问明细…" />;
  const rows = accesses.data?.accesses ?? [];
  if (rows.length === 0) return <p className="muted">还没有人打开过这个链接。</p>;

  return (
    <div className="log-list" style={{ marginTop: 'var(--space-2)' }}>
      {rows.map((a) => (
        <div key={a.id} className="log-item">
          <div className="log-item__body">
            <div className="row" style={{ gap: 'var(--space-2)' }}>
              <Tag tone={a.event === 'view' ? 'success' : 'warn'}>{EVENT_LABELS[a.event]}</Tag>
              {a.event === 'view' ? <span className="muted">当时可见 {a.itemCount} 条</span> : null}
            </div>
            <div className="log-item__meta">
              {formatDateTime(a.createdAt)}
              {a.ip ? ` · ${a.ip}` : ''}
              {a.userAgent ? ` · ${a.userAgent.slice(0, 60)}` : ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ShareLinkRow({ fid, link }: { fid: string; link: ShareLink }) {
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [showAccesses, setShowAccesses] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['share-links', fid] });
  const onError = (err: unknown) => push(err instanceof ApiError ? err.message : '操作失败', 'error');

  const revoke = useMutation({
    mutationFn: () => api.del(`/families/${fid}/share-links/${link.id}`),
    onSuccess: async () => {
      push('分享链接已撤销', 'success');
      await refresh();
    },
    onError,
  });

  const removeItem = useMutation({
    mutationFn: (itemId: string) => api.del(`/families/${fid}/share-links/${link.id}/items/${itemId}`),
    onSuccess: async () => {
      push('该条目已从分享中移除', 'success');
      await refresh();
    },
    onError,
  });

  const unlock = useMutation({
    mutationFn: () => api.post(`/families/${fid}/share-links/${link.id}/unlock`),
    onSuccess: async () => {
      push('密码锁定已解除', 'success');
      await refresh();
    },
    onError,
  });

  const expired = new Date(link.expiresAt).getTime() < Date.now();
  const locked = Boolean(link.lockedUntil && new Date(link.lockedUntil).getTime() > Date.now());
  const active = !link.revokedAt && !expired;
  const visibleItems = link.items.filter((i) => !i.trashed);

  return (
    <div className="log-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'flex-start' }}>
        <div className="log-item__body">
          <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <span>{link.label || '未命名分享'}</span>
            {link.hasPassword ? <Tag>有密码</Tag> : null}
            {active ? <Tag tone="success">有效</Tag> : <Tag tone="muted">{link.revokedAt ? '已撤销' : '已过期'}</Tag>}
            {locked ? <Tag tone="warn">密码已锁定至 {formatDateTime(link.lockedUntil!)}</Tag> : null}
          </div>
          <div className="log-item__meta">
            {visibleItems.length} 条记录 · 访问 {link.accessCount} 次 · 有效期至 {formatDateTime(link.expiresAt)}
            {link.lastAccessAt ? ` · 最近 ${formatDateTime(link.lastAccessAt)}` : ''}
          </div>
        </div>
        <div className="row" style={{ gap: 'var(--space-2)', flexShrink: 0 }}>
          <Button size="sm" variant="ghost" onClick={() => setShowAccesses((v) => !v)}>
            {showAccesses ? '收起明细' : '访问明细'}
          </Button>
          {locked ? (
            <Button size="sm" loading={unlock.isPending} onClick={() => unlock.mutate()}>
              解除锁定
            </Button>
          ) : null}
          {active ? (
            <Button size="sm" loading={revoke.isPending} onClick={() => revoke.mutate()}>
              撤销
            </Button>
          ) : null}
        </div>
      </div>

      {link.items.length > 0 ? (
        <div style={{ marginTop: 'var(--space-2)' }}>
          {link.items.map((item) => (
            <div key={item.itemId} className="row" style={{ gap: 'var(--space-2)', padding: '2px 0' }}>
              <span style={{ fontSize: 13, flex: 1, minWidth: 0 }}>
                {item.title}
                {item.trashed ? <Tag tone="muted">已删除</Tag> : null}
              </span>
              {active && !item.trashed ? (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={removeItem.isPending && removeItem.variables === item.itemId}
                  onClick={() => removeItem.mutate(item.itemId)}
                >
                  移出分享
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 13, marginTop: 'var(--space-1)' }}>
          链接下已没有可见条目。
        </p>
      )}

      {showAccesses ? <AccessList fid={fid} linkId={link.id} /> : null}
    </div>
  );
}

export function ShareLinkManager({ fid }: { fid: string }) {
  const shareLinks = useQuery({
    queryKey: ['share-links', fid],
    queryFn: () => api.get<{ shareLinks: ShareLink[] }>(`/families/${fid}/share-links`),
  });

  if (shareLinks.isPending) return <Spinner />;
  const links = shareLinks.data?.shareLinks ?? [];
  if (links.length === 0) {
    return <p className="muted">还没有分享过内容。打开某个条目，点「分享」即可生成链接。</p>;
  }
  return (
    <div className="log-list">
      {links.map((link) => (
        <ShareLinkRow key={link.id} fid={fid} link={link} />
      ))}
    </div>
  );
}
