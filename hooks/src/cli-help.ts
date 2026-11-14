export const HELP = `QuotaHot Hook - 独立的账户额度检查与切换命令，不启动 Web 服务。

用法：
  quotahot-hook status [选项]          查看账户额度和本机当前登录账户
  quotahot-hook switch [选项]          手动切换账户并同步客户端凭证
  quotahot-hook run opencode|omo [选项] OpenCode 或 OmO 插件的事件入口
  quotahot-hook notify <命令>          管理 OpenCode 会话群通知
  quotahot-hook recovery-status [--json]  查看本地额度恢复等待状态
  quotahot-hook recovery [--json]         recovery-status 的简写
  quotahot-hook install [omo] [--print] 安装 OpenCode 或独立 OmO 插件
  quotahot-hook uninstall [omo]         移除对应的 QuotaHot 插件
  quotahot-hook help [命令]             查看全局或命令帮助
  quotahot-hook version | --version    查看版本号

各命令可用 --help 查看参数；账户数据默认在 ~/.quotahot，可设置 QUOTAHOT_DATA_DIR。
`;

export const COMMAND_HELP: Readonly<Record<string, string>> = {
  'recovery-status': `用法：quotahot-hook recovery-status [--json]

只检查本地 OpenCode / OmO 额度恢复快照，不查询上游、不切换账户；读取时会删除超过三分钟无心跳的 stale 快照。
  --json  输出含等待会话和插件实例的结构化状态，便于诊断。
`,
  status: `用法：quotahot-hook status [选项]

查询账户额度与本机客户端在用账户，默认查询 Codex；可能更新本地额度缓存。
  --provider <codex|claude>  选择账户类型（默认 codex）。
  --threshold <percent>     上游未明确给出可用结论时，用于判断额度用尽的已用百分比（0–100，默认 80）。
  -c, --cache-seconds <seconds> 优先使用指定秒数内的额度缓存（默认 300）。
  --no-check               不请求上游，仅使用本地缓存；未知用量会标为 skipped。
  --json                   输出完整的账户状态和客户端登录映射。
`,
  switch: `用法：quotahot-hook switch [选项]

手动选择可用账户并覆盖目标客户端的当前登录凭证；切换前可用 --dry-run 预览。
  --provider <codex|claude>  选择账户类型（默认 codex）。
  --client <名称列表>       指定逗号分隔的写回目标：codex-cli、opencode、omo-agent、claude-cli、pi-claude、pi-codex；
                            默认按 provider 同步对应客户端（Pi 仅在已有凭证时写入）。覆盖登录有风险。
  --threshold <percent>     上游未明确给出可用结论时，用于判断额度用尽的已用百分比（0–100，默认 80）。
  -c, --cache-seconds <seconds> 使用额度缓存的秒数（默认 300）。
  -i, --min-interval-seconds <seconds> 两次切换间的最短秒数（默认 60）。
  --reason <text>           设置切换原因（默认“手动触发”）。
  --exhausted              将当前账户直接标为额度用尽并冷却；无需额度证据，请谨慎使用。
  --no-check               不请求上游额度，可能按旧缓存或未知用量选错账户。
  --dry-run                只预览，不写状态、缓存或凭证；过期令牌无法只读刷新。
  --json                   输出完整切换结果（可能包含账户邮箱）。
`,
  run: `用法：quotahot-hook run opencode|omo [选项]

从标准输入读取 OpenCode 或独立 OmO 事件；只对 Codex 明确额度信号尝试切换，运行故障时不阻断插件。
额度事件固定按 OpenCode 的来源、原因及额度阈值处理，不接受手动切换参数。
  -i, --min-interval-seconds <seconds> 切换间隔（默认 60）；设为 0 会绕过间隔保护。
  --no-check               不查询上游额度，可能按旧缓存或未知用量选错账户。
  --dry-run                只预览，不写切换状态或客户端凭证。
  --json                   标准输出仍是插件 JSON；诊断结果另写标准错误。
`,
  notify: `用法：quotahot-hook notify <configure|enable|disable|status|install|uninstall> [选项]

configure 用精确 openConversationId 核验群身份并保存为未启用；enable --yes 明确授权持续自动发送。
  configure --group <openConversationId>  核验并保存唯一群目标，保持通知关闭。
  enable --yes                            启用已保存的目标群，允许未来会话自动通知。
  disable                                 停止自动通知并保留目标配置。
  status [--json]                         查看当前启用状态及已核验群身份。
  install [--print]                       安装独立通知插件；--print 只预览。
  uninstall                               只移除独立通知插件。
`,
  install: `用法：quotahot-hook install [omo] [--print]

默认安装 OpenCode 插件并清理自有的旧 Codex/Pi 触发器；指定 omo 则只安装独立 OmO 插件。都不修改账户凭证。
  --print  只打印插件路径及内容，不安装、不清理、不写文件。
`,
  uninstall: '用法：quotahot-hook uninstall [omo]\n\n默认移除 OpenCode 插件和旧触发器；指定 omo 只移除独立 OmO 插件，不删除账户凭证。\n',
  version: '用法：quotahot-hook version\n\n打印当前独立 hook 程序的版本号，不启动服务。\n',
};
