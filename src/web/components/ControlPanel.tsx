import { useEffect, useState, type ReactNode } from 'react';
import type { AppConfig, ModelCatalog, ProviderCatalog } from '../../shared/types.js';
import { MODEL_OPTIONS } from '../../shared/models.js';
import { validateProxy } from '../../shared/proxy.js';

/** 拆分逗号分隔的忽略代理输入；对空格和多余逗号保持宽容。 */
function splitRules(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((r) => r.trim())
    .filter(Boolean);
}

const CUSTOM = '__custom__';

/** 模型目录还没拉回来时先用内置清单渲染，避免下拉框闪一下空白。 */
function fallbackCatalog(provider: 'claude' | 'codex'): ProviderCatalog {
  return { options: MODEL_OPTIONS[provider], fromUpstream: false, error: '' };
}

/**
 * 模型选择器。
 *
 * 选项来自服务端按账户查到的模型目录；账户查不通或者压根没有这类账户时，
 * 服务端会退回内置清单，这里把原因显示出来，免得用户以为下拉框就该长这样。
 * 无论哪种情况都保留“自定义”入口：配置本来就接受任意字符串。
 */
function ModelField({
  label,
  value,
  catalog,
  onChange,
}: {
  label: string;
  value: string;
  catalog: ProviderCatalog;
  onChange: (id: string) => void;
}) {
  // 一旦选了自定义，就保持文本输入模式；即使后来输入值恰好命中已知模型也不自动切回
  const [picked, setPicked] = useState(false);
  // 列表外的模型 ID 必须显示文本框，否则下拉框会出现空白值
  const listed = catalog.options.some((m) => m.id === value);
  const custom = picked || !listed;
  const setCustom = setPicked;

  const hint = custom
    ? '自定义模型 ID，发送前请确认上游支持'
    : catalog.fromUpstream
      ? '来自账户可用模型'
      : catalog.error
        ? `没查到账户可用模型，用的是内置清单：${catalog.error}`
        : '内置清单，添加账户后会换成账户可用模型';

  return (
    <label className="field grow">
      <span>
        {label}
        <em className="hint">{hint}</em>
      </span>
      <div className="model-pick">
        <select
          value={custom ? CUSTOM : value}
          onChange={(e) => {
            if (e.target.value === CUSTOM) {
              setCustom(true);
            } else {
              setCustom(false);
              onChange(e.target.value);
            }
          }}
        >
          {catalog.options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          <option value={CUSTOM}>自定义…</option>
        </select>
        {custom && (
          <input
            type="text"
            placeholder="模型 ID"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </div>
    </label>
  );
}

/**
 * 配置页的一组设置。
 *
 * 所有参数堆在一块时，用户得逐个读标签才知道自己在改哪一环；按功能切开之后，
 * 组标题先说清楚这一组管什么，找起来就只需要在四个标题之间挑。
 */
function Group({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint: string;
  /** 组标题右侧的操作按钮，例如“刷新模型”。 */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="config-group">
      <header className="group-head">
        <h3>{title}</h3>
        <p>{hint}</p>
        {action && <div className="spacer" />}
        {action}
      </header>
      {children}
    </section>
  );
}

interface Props {
  config: AppConfig;
  busy: boolean;
  /** 服务端当前实际生效的代理，用来和草稿值比较。 */
  proxy: string;
  onSave: (cfg: AppConfig) => void;
  /** 服务端查到的可用模型；还没拉回来时为 null。 */
  catalog: ModelCatalog | null;
  onRefreshModels: () => void;
  /** 有未保存改动时通知外层，好在标签页上标个点——这一页可能正被藏着。 */
  onDirtyChange: (dirty: boolean) => void;
}

export function ControlPanel({
  config,
  busy,
  proxy,
  onSave,
  catalog,
  onRefreshModels,
  onDirtyChange,
}: Props) {
  const [draft, setDraft] = useState(config);
  // 忽略代理列表按自由文本编辑；若每次按键都经过数组往返，会把刚输入的逗号吃掉
  const [noProxyText, setNoProxyText] = useState(config.noProxy.join(', '));

  // 当服务端配置变化时同步草稿，但不要覆盖用户正在进行中的本地编辑
  useEffect(() => {
    setDraft(config);
    setNoProxyText(config.noProxy.join(', '));
  }, [config]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(config);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const patch = (p: Partial<AppConfig>) => setDraft((d) => ({ ...d, ...p }));

  // 与服务端使用同一套规则，让用户在保存前就能看到错误，而不是保存后才被拒绝
  const proxyError = validateProxy(draft.proxy);
  const hasProxy = draft.proxy.trim() !== '';
  const proxyPending = !proxyError && draft.proxy.trim() !== proxy;

  // 这里的窗口表示每天重复的时刻区间，所以要把两个不直观的情况说明白
  const windowHint =
    draft.dailyStart === draft.dailyEnd
      ? '两端相同 = 全天不停'
      : draft.dailyEnd < draft.dailyStart
        ? '每天重复 · 跨零点到次日'
        : '每天重复，只在此区间内发送';

  return (
    <section className="panel config">
      <Group
        title="保活发送"
        hint="每一轮发什么、用哪个模型"
        action={
          <button
            className="link"
            onClick={onRefreshModels}
            title="重新向账户查询可用模型，跳过服务端缓存"
          >
            刷新模型
          </button>
        }
      >
        <div className="panel-row">
          <label className="field grow">
            <span>提示词</span>
            <input
              type="text"
              value={draft.text}
              placeholder="每轮发送的自定义文本"
              onChange={(e) => patch({ text: e.target.value })}
            />
          </label>
        </div>
        <div className="panel-row">
          <ModelField
            label="Claude 模型"
            value={draft.models.claude}
            catalog={catalog?.claude ?? fallbackCatalog('claude')}
            onChange={(id) => patch({ models: { ...draft.models, claude: id } })}
          />
          <ModelField
            label="Codex 模型"
            value={draft.models.codex}
            catalog={catalog?.codex ?? fallbackCatalog('codex')}
            onChange={(id) => patch({ models: { ...draft.models, codex: id } })}
          />
        </div>
      </Group>

      <Group title="发送时机" hint="每天什么时候发、跟着哪条窗口走">
        <div className="panel-row">
          <label className="field">
            <span>
              每天开始
              <em className="hint">{windowHint}</em>
            </span>
            <input
              type="time"
              value={draft.dailyStart}
              onChange={(e) => patch({ dailyStart: e.target.value })}
            />
          </label>

          <label className="field">
            <span>每天结束</span>
            <input
              type="time"
              value={draft.dailyEnd}
              onChange={(e) => patch({ dailyEnd: e.target.value })}
            />
          </label>
        </div>
        <div className="panel-row">
          <label className="field">
            <span>
              缓冲秒数
              <em className="hint">重置时刻之后再等这么久</em>
            </span>
            <input
              type="number"
              min={0}
              value={draft.bufferSeconds}
              onChange={(e) => patch({ bufferSeconds: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>
              抖动秒数
              <em className="hint">错开多个账户，避免同一秒一起发</em>
            </span>
            <input
              type="number"
              min={0}
              value={draft.jitterSeconds}
              onChange={(e) => patch({ jitterSeconds: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>
              最大重试
              <em className="hint">一轮发送失败后最多再试几次</em>
            </span>
            <input
              type="number"
              min={1}
              max={10}
              value={draft.maxRetries}
              onChange={(e) => patch({ maxRetries: Number(e.target.value) })}
            />
          </label>
        </div>
      </Group>

      <Group title="额度查询" hint="卡片上的用量数字多久自己更新一次">
        <div className="panel-row">
          <label className="field">
            <span>
              额度刷新（分钟）
              <em className="hint">
                {draft.usageRefreshMinutes > 0 ? '后台自动只读查询' : '0 = 只在点按钮时查询'}
              </em>
            </span>
            <input
              type="number"
              min={0}
              max={1440}
              value={draft.usageRefreshMinutes}
              onChange={(e) => patch({ usageRefreshMinutes: Number(e.target.value) })}
            />
          </label>
        </div>
      </Group>

      <Group title="网络" hint="所有上游请求与 token 刷新的出口">
        <div className="panel-row">
          <label className="field grow">
            <span>
              代理
              <em className="hint">
                {proxyError
                  ? proxyError
                  : proxyPending
                    ? '改动尚未保存，当前仍按上一次生效的设置发送'
                    : draft.proxy.trim()
                      ? '所有上游请求与 token 刷新都走它'
                      : '留空为直连'}
              </em>
            </span>
            <input
              type="text"
              className={proxyError ? 'invalid' : ''}
              placeholder="http://127.0.0.1:7897，留空为直连"
              value={draft.proxy}
              onChange={(e) => patch({ proxy: e.target.value })}
            />
          </label>

          <label className="field grow">
            <span>
              忽略代理
              <em className="hint">
                {hasProxy
                  ? '逗号分隔，命中的主机直连；支持 example.com、.example.com、host:port、*'
                  : '未配置代理，此处不生效'}
              </em>
            </span>
            <input
              type="text"
              disabled={!hasProxy}
              placeholder="localhost, 127.0.0.1, .internal"
              value={noProxyText}
              onChange={(e) => {
                setNoProxyText(e.target.value);
                patch({ noProxy: splitRules(e.target.value) });
              }}
            />
          </label>
        </div>
      </Group>

      <div className="panel-row actions config-actions">
        <div className="spacer" />
        <button
          className="save"
          disabled={!dirty || busy || proxyError !== null}
          title={proxyError ?? ''}
          onClick={() => onSave(draft)}
        >
          {dirty ? '保存配置' : '已保存'}
        </button>
      </div>
    </section>
  );
}
