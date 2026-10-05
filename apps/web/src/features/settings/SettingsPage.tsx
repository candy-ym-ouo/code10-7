import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, Field, SegmentedControl, Spinner, TextArea, TextInput } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { useFamily } from '../families/useFamily';
import { ShareLinksManager } from '../share/ShareLinksManager';
import { VISIBILITY_LABELS } from '../../lib/constants';
import { formatBytes } from '../../lib/format';
import type { Visibility } from '../../api/types';

interface ExportJob {
  jobId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  lastError: string | null;
  downloadUrl: string | null;
  result: { items?: number; media?: number; bytes?: number } | null;
}

export function SettingsPage() {
  const { fid } = useParams<{ fid: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const { reloadMemberships } = useAuth();
  const { data: familyData } = useFamily(fid);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('family');
  const [allowViewerComment, setAllowViewerComment] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);

  useEffect(() => {
    if (!familyData) return;
    setName(familyData.family.name);
    setDescription(familyData.family.description ?? '');
    setVisibility(familyData.family.defaultVisibility);
    setAllowViewerComment(familyData.family.allowViewerComment);
  }, [familyData]);

  const exportJob = useQuery({
    queryKey: ['export', fid, jobId],
    queryFn: () => api.get<{ job: ExportJob }>(`/families/${fid}/exports/${jobId}`),
    enabled: Boolean(fid && jobId),
    refetchInterval: (q) => {
      const data = q.state.data as { job: ExportJob } | undefined;
      return data && (data.job.status === 'done' || data.job.status === 'failed') ? false : 1500;
    },
  });

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/families/${fid}`, {
        name: name.trim(),
        description: description.trim() || null,
        defaultVisibility: visibility,
        allowViewerComment,
      }),
    onSuccess: async () => {
      push('设置已保存', 'success');
      await queryClient.invalidateQueries({ queryKey: ['family', fid] });
      await reloadMemberships();
    },
    onError: (err) => push(err instanceof ApiError ? err.message : '保存失败', 'error'),
  });

  const startExport = useMutation({
    mutationFn: () => api.post<{ jobId: string }>(`/families/${fid}/exports`),
    onSuccess: (data) => {
      setJobId(data.jobId);
      push('导出任务已开始，完成后可以直接下载', 'success');
    },
    onError: (err) => push(err instanceof ApiError ? err.message : '发起导出失败', 'error'),
  });

  const removeFamily = useMutation({
    mutationFn: () => api.del(`/families/${fid}`),
    onSuccess: async () => {
      push('家庭空间已删除', 'success');
      await reloadMemberships();
      navigate('/');
    },
    onError: (err) => push(err instanceof ApiError ? err.message : '删除失败', 'error'),
  });

  if (!familyData) return <Spinner />;
  const isOwner = familyData.myRole === 'owner';
  const job = exportJob.data?.job;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>家庭设置</h1>
          <p className="page-head__sub">数据只存在你自己的服务器上，可以随时导出成离线文件。</p>
        </div>
      </div>

      <section className="card">
        <h2 style={{ marginBottom: 'var(--space-4)' }}>基本信息</h2>
        <Field label="家庭名称" required>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </Field>
        <Field label="说明">
          <TextArea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </Field>
        <Field label="新建条目的默认可见范围" group>
          <SegmentedControl
            name="默认可见范围"
            value={visibility}
            onChange={setVisibility}
            options={(Object.keys(VISIBILITY_LABELS) as Visibility[]).map((v) => ({
              value: v,
              label: VISIBILITY_LABELS[v],
            }))}
          />
        </Field>
        <label className="row" style={{ gap: 8, marginBottom: 'var(--space-4)' }}>
          <input type="checkbox" checked={allowViewerComment} onChange={(e) => setAllowViewerComment(e.target.checked)} />
          <span>允许「只读」成员留言和补充故事</span>
        </label>
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          保存设置
        </Button>
      </section>

      <section className="card">
        <div className="card__head">
          <h2>导出全部数据</h2>
          <Button variant="primary" loading={startExport.isPending} onClick={() => startExport.mutate()}>
            开始导出
          </Button>
        </div>
        <p className="muted">
          导出包含一个 ZIP：条目总表（items.csv）、每条物品的 Markdown 档案、全部原始图片与录音，以及带 sha256 校验的媒体清单。不依赖本系统也能打开。
        </p>
        {job ? (
          <div className="card" style={{ background: 'var(--surface-2)' }}>
            <div className="row row--between">
              <span>
                状态：
                {job.status === 'queued'
                  ? '排队中'
                  : job.status === 'running'
                    ? `生成中 ${job.progress}%`
                    : job.status === 'done'
                      ? '已完成'
                      : '失败'}
              </span>
              {job.status === 'done' && job.downloadUrl ? (
                <a className="btn btn--primary btn--sm" href={job.downloadUrl}>
                  下载 ZIP
                  {job.result?.bytes ? `（${formatBytes(job.result.bytes)}）` : ''}
                </a>
              ) : null}
            </div>
            {job.lastError ? <p className="field__error">{job.lastError}</p> : null}
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2 style={{ marginBottom: 'var(--space-3)' }}>已创建的分享链接</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          展开链接可查看每个条目的单独失效/恢复与访客访问明细；撤销链接、链接过期或条目被删除时，内容与媒体会同时对访客关闭。
        </p>
        <ShareLinksManager fid={fid!} />
      </section>

      <section className="card">
        <div className="card__head">
          <h2>回收站</h2>
          <Link className="btn btn--sm" to={`/f/${fid}/trash`}>
            打开回收站
          </Link>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          被删除的条目会保留 30 天，期间可以恢复；到期后连同图片、录音一起彻底清除。
        </p>
      </section>

      {isOwner ? (
        <section className="card" style={{ borderColor: 'var(--accent)' }}>
          <h2 style={{ marginBottom: 'var(--space-3)', color: 'var(--accent)' }}>危险操作</h2>
          <p className="muted">
            删除家庭空间后，所有条目、图片、录音都会不可访问（备份中的副本按备份保留策略自然过期）。请输入家庭名称
            <strong>{familyData.family.name}</strong> 以确认。
          </p>
          <Field label="输入家庭名称确认">
            <TextInput value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
          </Field>
          <Button
            variant="danger"
            loading={removeFamily.isPending}
            disabled={confirmName !== familyData.family.name}
            onClick={() => removeFamily.mutate()}
          >
            删除整个家庭空间
          </Button>
        </section>
      ) : null}
    </div>
  );
}
