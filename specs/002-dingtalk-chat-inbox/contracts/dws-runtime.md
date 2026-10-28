# DWS 子进程契约

## 宿主边界

独立 DingTalk Inbox 服务作为 DWS 子进程唯一所有者。执行固定命令与参数数组，禁止 shell 拼接；使用服务配置的 `DINGTALK_INBOX_DWS_BIN` 和 `DINGTALK_INBOX_DWS_PROFILE`，对每条命令显式传递同一 DWS 全局 `--profile`。真实 CLI flag 位置由部署预检的 Schema 确认。`DWS_CONFIG_DIR` 指向独立服务自有私密数据目录下的配置子目录，DWS 原生命令负责 profile 文件格式和权限；Inbox 服务不拷贝或修改 DWS 认证文件。QuotaHot 不启动 DWS、不读该目录，且不是服务启动依赖。

消息正文、认证信息及完整 stdout/stderr 均不得写入应用日志。子进程必须由服务专用 OS 身份运行。stderr 仅提取 ready/exit 状态和脱敏错误；stdout 只作为 NDJSON 事件输入。

## 搜索命令

人员按姓名搜索：

```text
dws aisearch person --query <query> --dimension name --format json
```

仅将真实返回候选投影为 `{ userId, displayName, department? }`。多候选显示给用户确认，零候选为空结果；不自动选第一项、不转换成联系人/会话列表。AISearch 返回完整性不足或缺 `userId` 时禁止选择。

群按关键词搜索：

```text
dws chat +chat-search --query <query> --page-all --format json
```

仅将真实返回候选投影为 `{ openConversationId, displayName }`。检查 `complete/hasMore/failures`；多候选必须由用户选定，不能根据排序自动选择。群身份只用于 group 目标，不传给 person 命令。

## 目标监听

Person 单聊：

```text
dws event consume user_im_message_receive_o2o --user <userId> --flatten -f ndjson
```

Group 群聊：

```text
dws event consume user_im_message_receive_group --group <openConversationId> --flatten -f ndjson
```

Person 目标禁止改用 `user_im_message_receive_user`，因为后者覆盖该用户在单聊和群聊中的消息；全部用户/全部群事件禁止使用。

## 消费进程生命周期

1. 使用 argv 数组启动，不使用 shell；保持 stdin 管道打开，持续并发读取 stdout 与 stderr，避免背压。
2. 监听在 stderr 的 `[event] ready event_key=<key> bus_pid=<pid> subscribe_id=<id>` 行到达后才进入 `ready`；不得使用 `--quiet` 或固定等待时间代替。
3. stdout 按行增量解析 NDJSON；每个 JSON 对象独立校验。未知字段允许忽略，但目标/会话身份字段缺失时不得展示为正常消息。
4. 切换或停止时关闭 stdin 或发送 SIGTERM，等待正常退出和新建订阅清理；禁止 `SIGKILL`。保留旧 `subscriptionId` 上下文处理已经读入的迟到事件。
5. 非零退出、ready 前失败或运行期间终止均转成订阅失败/中断状态。独立服务重启时，按持久化的监听意图为当前目标启动新的 consumer 代次；新代次未收到匹配的 ready marker 前不得显示为 `ready`。显式停止过的目标不自动重启。
6. DWS 当前契约没有承诺 consumer 自身 stream 自动重连或事件补发；独立服务重启后创建新的 consumer 不代表能补回停机期间的消息。QuotaHot 重启不得影响 consumer。不得因此静默改用轮询、全量订阅或伪造历史消息。

## 发送文本

Person 单聊：

```text
dws chat +messages-send --as user --user <userId> --text <text> --idempotency-key <requestId> --format json
```

Group 群聊：

```text
dws chat +messages-send --as user --group <openConversationId> --text <text> --idempotency-key <requestId> --format json
```

上述命令形式须在部署预检时对实际安装的 DWS 版本通过 schema/CLI dry-run 核验。请求只取活动目标的稳定 ID，不接受前端提供的任意 display name。按 `--format json` 的真实结构归一结果；只有明确回执表明 DingTalk 已接受请求时才归为 `accepted`，该状态不代表对方已收到或已读；明确失败归为 `failed`，超时或连接中断而无法确定服务端是否接受归为 `unknown`。`unknown` 不自动重发，即使提供幂等键也不声称上游一定去重。

## 版本与配置

- `DINGTALK_INBOX_DWS_BIN` 是独立服务配置的可执行路径；缺少或版本契约不兼容时，能力状态为不可用，不启动伪造监听。
- `DINGTALK_INBOX_DWS_PROFILE` 是独立服务显式配置的 profile，并作为全局 `--profile` 传给每条命令；不得默认选择“最近登录”或第一个 profile。
- `DWS_CONFIG_DIR` 由服务设置在服务私有数据目录；不得指向或读取 QuotaHot 数据目录，严禁输出或回传其认证内容。
- 搜索与目标命令使用相同 profile；profile 切换使旧目标 ID 失效，需重新搜索。
