import { useId, useState } from 'react';
import type { TaskModelsResponse } from '../../shared/tasks.js';

const CUSTOM_MODEL = '__custom__';

export interface TaskModelDiscovery {
  readonly response: TaskModelsResponse | null;
  readonly loading: boolean;
  readonly error: string;
  readonly refresh: () => void;
}

interface Props {
  readonly value: string;
  readonly discovery: TaskModelDiscovery;
  readonly onChange: (model: string) => void;
}

export function TaskModelField({ value, discovery, onChange }: Props) {
  const labelId = useId();
  const statusId = useId();
  const [customSelected, setCustomSelected] = useState(false);
  const models = discovery.response?.models ?? null;
  const listed = models?.includes(value) ?? true;
  const custom = customSelected || !listed;
  const options = models ?? [value];

  const status = discovery.loading
    ? '正在读取当前目录的 OpenCode 模型…'
    : discovery.error !== ''
      ? `模型列表获取失败：${discovery.error}。仍可使用当前模型或输入自定义模型。`
      : discovery.response === null
        ? '打开任务页后会读取当前目录的 OpenCode 模型。'
        : `已从 ${discovery.response.directory} 读取 ${models?.length ?? 0} 个模型。`;

  return (
    <div className="field task-field task-model-field" aria-busy={discovery.loading}>
      <span id={labelId}>
        Provider / Model
        <em className="hint">选择当前目录可用的模型，或使用自定义 provider/model</em>
      </span>
      <div className="task-model-controls">
        <select
          required
          value={custom ? CUSTOM_MODEL : value}
          aria-labelledby={labelId}
          aria-describedby={statusId}
          onChange={(event) => {
            if (event.target.value === CUSTOM_MODEL) {
              setCustomSelected(true);
              return;
            }
            setCustomSelected(false);
            onChange(event.target.value);
          }}
        >
          {options.map((model) => (
            <option key={model} value={model}>{model}</option>
          ))}
          <option value={CUSTOM_MODEL}>自定义…</option>
        </select>
        <button
          className="ghost"
          type="button"
          disabled={discovery.loading}
          onClick={discovery.refresh}
        >
          {discovery.loading ? '正在刷新…' : '刷新模型'}
        </button>
      </div>
      {custom && (
        <label className="task-model-custom">
          <span>自定义 Provider / Model</span>
          <input
            required
            type="text"
            value={value}
            placeholder="provider/model"
            spellCheck={false}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      )}
      <small
        id={statusId}
        className={`task-field-note${discovery.error === '' ? '' : ' task-model-status-error'}`}
        role="status"
        aria-live="polite"
      >
        {status}
      </small>
    </div>
  );
}
