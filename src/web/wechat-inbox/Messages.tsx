import type { WechatMessage, WechatMessageItem } from '../../shared/wechat-inbox.js';
import { attachmentUrl } from './api.js';
import { formatMessageTime } from './time.js';

export const MESSAGE_STATES: Readonly<Record<WechatMessage['state'], string>> = {
  received: '已接收', queued: '等待发送', uploading: '正在上传', sending: '正在发送',
  accepted: '请求已接受，不代表已送达或已读', failed: '发送失败，请检查后手动处理',
  unknown: '结果未知，请人工核对微信记录，不会自动重试',
};

function MessageItem({ item }: { readonly item: WechatMessageItem }) {
  const url = item.attachmentId ? attachmentUrl(item.attachmentId) : null;
  const download = url ? <a href={url} download>下载{item.fileName ? ` ${item.fileName}` : '附件'}</a> : <p className="wechat-note">附件尚未保存或不可用。</p>;
  switch (item.kind) {
    case 'text': return <p>{item.text}</p>;
    case 'protocol_event': return <p>协议消息：{item.text || '暂不支持展示此类内容。'}</p>;
    case 'image': return <div className="wechat-media">{url && <div className="wechat-media-frame"><img src={url} alt="微信图片附件" loading="lazy" /></div>}{download}</div>;
    case 'voice': return <div className="wechat-media">{url && <audio controls src={url} preload="none" aria-label="微信语音附件" />}{item.text && <p>{item.text}</p>}{download}</div>;
    case 'video': return <div className="wechat-media">{url && <div className="wechat-media-frame"><video controls src={url} preload="none" aria-label="微信视频附件" /></div>}{download}</div>;
    case 'file': return <div className="wechat-media">{download}{item.sizeBytes != null && <span className="wechat-note">{item.sizeBytes.toLocaleString('zh-CN')} 字节</span>}</div>;
    default: return item satisfies never;
  }
}

export function InboxMessages({ messages }: { readonly messages: readonly WechatMessage[] }) {
  return <ol className="wechat-messages" aria-label="已保存的绑定消息">{messages.map((message) => {
    const time = formatMessageTime(message.createdAt);
    return <li key={message.id}>
    <div className="wechat-note">{message.direction === 'inbound' ? '收到' : '发出'} · {MESSAGE_STATES[message.state]} · <time dateTime={message.createdAt} title={time.absolute} aria-label={time.absolute}>{time.relative}</time></div>
    {message.text && <p>{message.text}</p>}
    {message.items.map((item, index) => item.kind === 'text' && item.text === message.text ? null
      : <MessageItem key={`${message.id}:${index}`} item={item} />)}
    {!message.text && message.items.length === 0 && <p>{message.kind === 'protocol_event' ? '协议消息：暂不支持展示此类内容。' : '此消息暂无可展示的已保存内容。'}</p>}
  </li>;
  })}</ol>;
}
