interface Props {
  busy: boolean;
  /** 账户总数，用来决定全选/清空的状态。 */
  total: number;
  /** 当前勾选的账户数；0 表示未勾选，此时批量操作作用于全部账户。 */
  selected: number;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onTestSelected: () => void;
  onUsage: () => void;
  onAccounts: () => void;
  /** 把作用范围内的账户批量加入 / 退出 API 服务。 */
  onGatewayBulk: (enabled: boolean) => void;
}

/**
 * 账户页顶部的动作条。
 *
 * 这里放的都是**作用在账户上**的操作：管理账户、批量测试、批量查额度。
 * 它们和卡片是一回事，所以跟卡片同处一页；调参数那些留在配置页，
 * 起停调度和下次/上次发送时间在调度任务页——那是调度的事，不是账户的属性。
 *
 * 批量按钮的作用范围跟着卡片上的勾选走；一个都没勾时按“全部账户”处理，
 * 这样不想筛选的人可以完全无视勾选框。
 */
export function RunBar({
  busy,
  total,
  selected,
  onSelectAll,
  onClearSelection,
  onTestSelected,
  onUsage,
  onAccounts,
  onGatewayBulk,
}: Props) {
  const scope = selected === 0 ? `全部 ${total}` : `${selected}`;

  return (
    <div className="runbar">
      <button className="link" onClick={onAccounts}>
        管理账户
      </button>

      {total > 0 && (
        <span className="select-hint">
          <button className="link" onClick={onSelectAll} disabled={selected === total}>
            全选
          </button>
          <button className="link" onClick={onClearSelection} disabled={selected === 0}>
            清空
          </button>
          {selected === 0 ? '未勾选 · 操作作用于全部账户' : `已勾选 ${selected} / ${total}`}
        </span>
      )}

      <div className="spacer" />

      <button
        className="ghost"
        disabled={busy || total === 0}
        onClick={onTestSelected}
        title="对勾选的账户逐个真发一条，和卡片上的「测试文本」是同一件事，会打开 5 小时窗口"
      >
        测试文本（{scope}）
      </button>

      <button
        className="ghost"
        disabled={busy || total === 0}
        onClick={onUsage}
        title="只读查询勾选账户的当前额度，不发消息、不消耗配额、不会开启 5 小时窗口"
      >
        查询额度（{scope}）
      </button>

      {/*
        决定「哪些账户参与 API 转发」的批量入口。作用范围跟着上面的勾选走，和测试/查额度一致。
        只作用于支持转发的 provider，别的会被服务端跳过。加入是把额度交出去，退出是收回来，
        两件事分成两个明确的按钮，比一个会随状态变文案的开关更不容易点错。
      */}
      <button
        className="ghost"
        disabled={busy || total === 0}
        onClick={() => onGatewayBulk(true)}
        title="把作用范围内的账户加入 API 服务的账号池，它们的额度会被转发请求用掉（不影响全局开关）"
      >
        加入 API 服务（{scope}）
      </button>

      <button
        className="ghost"
        disabled={busy || total === 0}
        onClick={() => onGatewayBulk(false)}
        title="把作用范围内的账户移出 API 服务，不再派新的转发请求给它们"
      >
        退出 API 服务（{scope}）
      </button>
    </div>
  );
}
