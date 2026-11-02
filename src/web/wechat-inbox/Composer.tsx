import { useId, useRef, useState } from 'react';
import type { InboxLoader, InboxState } from './loader.js';
import { MESSAGE_STATES } from './Messages.js';

const SEND_KINDS = ['text', 'image', 'file', 'video'] as const;
export function InboxComposer({ state, loader, canSend, waitingForInbound }: { readonly state: InboxState; readonly loader: InboxLoader; readonly canSend: boolean; readonly waitingForInbound: boolean }) {
  const helpId = useId();
  const voiceId = useId();
  const [kind, setKind] = useState<typeof SEND_KINDS[number]>('text');
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = state.sending !== '';
  const disabled = !canSend || busy;
  const submit = async () => {
    if (disabled) return;
    const bindingId = state.bindingId;
    switch (kind) {
      case 'text': await loader.send({ kind, text: state.draft }); break;
      case 'image': case 'file': case 'video':
        if (file === null) return;
        await loader.send({ kind, file });
        if (loader.getState().bindingId === bindingId && loader.getState().outcome === 'accepted') {
          setFile(null);
          if (fileInput.current) fileInput.current.value = '';
        }
        break;
      default: kind satisfies never;
    }
  };
  return <form className="wechat-composer" aria-label="手动发送消息" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <p id={helpId} className="wechat-note">仅手动发送，不调用 AI。请求已接受不代表已送达或已读；结果未知时请先人工核对，不会自动重试。</p>
    {waitingForInbound ? <p role="status">请让当前绑定用户先在微信中向本平台发送一条消息，收到后才能回复或设置输入状态。</p>
      : !canSend && <p role="status">当前绑定为只读状态，不能发送或设置输入状态。</p>}
    <label className="field"><span>发送类型</span><select value={kind} disabled={disabled} onChange={(event) => {
      const next = SEND_KINDS.find((value) => value === event.target.value);
      if (next) { setKind(next); setFile(null); if (fileInput.current) fileInput.current.value = ''; }
    }} aria-describedby={voiceId}>
      <option value="text">文本</option><option value="image">图片</option><option value="file">文件</option><option value="video">视频</option>
      <option disabled value="voice">语音（暂未开放）</option>
    </select></label>
    <p id={voiceId} className="wechat-note">语音出站在本次范围内保持禁用。收到的语音可通过本地附件播放或下载。</p>
    {kind === 'text' ? <label className="field task-field"><span>消息正文</span><textarea rows={3} value={state.draft} disabled={!canSend} aria-describedby={helpId}
       placeholder="输入要发送给所选绑定用户的文本" onChange={(event) => loader.setDraft(event.target.value)} /></label>
      : <label className="field"><span>选择{kind === 'image' ? '图片' : kind === 'video' ? '视频' : '文件'}</span><input ref={fileInput} type="file" disabled={disabled}
        accept={kind === 'image' ? 'image/*' : kind === 'video' ? 'video/*' : undefined} aria-describedby={helpId}
        onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>}
    {file && <p className="wechat-note">已选择：{file.name} · {file.size.toLocaleString('zh-CN')} 字节</p>}
    {state.outcome && <p role={state.outcome === 'accepted' ? 'status' : 'alert'}>{MESSAGE_STATES[state.outcome]}</p>}
    {state.sendError && <p role="alert">{state.sendError}</p>}
    <button type="submit" className="primary" disabled={disabled || (kind === 'text' ? !state.draft.trim() : file === null)}>
      {state.sending === 'media' ? '正在上传并提交…' : busy ? '正在提交…' : kind === 'text' ? '发送文本' : '上传并发送'}</button>
    <div className="wechat-actions" aria-busy={state.typingBusy}>
      <button type="button" disabled={!canSend || state.typingBusy || state.typing} onClick={() => void loader.typing('typing')}>开始输入状态</button>
      <button type="button" disabled={!canSend || !state.typing} onClick={() => void loader.typing('cancel')}>取消输入状态</button>
      {state.typing && <span role="status">已请求显示正在输入</span>}
    </div>
    {state.typingError && <p role="alert">输入状态未确认：{state.typingError}</p>}
  </form>;
}
