import { InboxPane } from '../wechat-inbox/InboxPane.js';

export function WechatPane({ active }: { readonly active: boolean }) {
  return <main className="task-pane wechat-pane"><InboxPane active={active} /></main>;
}
