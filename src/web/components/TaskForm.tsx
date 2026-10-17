import { useId, useState, type SubmitEvent } from 'react';
import type { CreateTaskInput, TaskSummary, TaskTrigger } from '../../shared/tasks.js';
import { TaskModelField, type TaskModelDiscovery } from './TaskModelField.js';

interface Props {
  readonly defaultDirectory: string;
  readonly directory: string;
  readonly tasks: readonly TaskSummary[];
  readonly modelDiscovery: TaskModelDiscovery;
  readonly onDirectoryChange: (directory: string) => void;
  readonly onCreate: (input: CreateTaskInput) => Promise<void>;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected task trigger: ${String(value)}`);
}

function localDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const local = new Date(timestamp - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function TaskForm({
  defaultDirectory,
  directory,
  tasks,
  modelDiscovery,
  onDirectoryChange,
  onCreate,
}: Props) {
  const [description, setDescription] = useState('');
  const [model, setModel] = useState('openai/gpt-6-luna-fast');
  const [triggerType, setTriggerType] = useState<TaskTrigger['type']>('quota');
  const [scheduledAt, setScheduledAt] = useState('');
  const [predecessorId, setPredecessorId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const predecessorHintId = useId();
  const predecessorAvailable = tasks.some((task) => task.id === predecessorId);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const taskDescription = description.trim();
    const taskModel = model.trim();
    const taskDirectory = directory.trim() || defaultDirectory;

    if (taskDescription === '' || taskModel === '') {
      setError('请填写任务描述和 OpenCode provider/model。');
      return;
    }
    if (taskDirectory === '') {
      setError('尚未取得默认工作目录，请填写目录或重试加载任务列表。');
      return;
    }

    let trigger: TaskTrigger;
    switch (triggerType) {
      case 'quota':
        trigger = { type: 'quota' };
        break;
      case 'time': {
        const at = new Date(scheduledAt).getTime();
        if (!Number.isFinite(at) || at <= Date.now()) {
          setError('请选择一个晚于当前时间的执行时刻。');
          return;
        }
        trigger = { type: 'time', at };
        break;
      }
      case 'task':
        if (predecessorId === '') {
          setError('请选择一个前置任务。');
          return;
        }
        if (!predecessorAvailable) {
          setError('所选前置任务已不存在，请重新选择。');
          return;
        }
        trigger = { type: 'task', taskId: predecessorId };
        break;
      default:
        trigger = assertNever(triggerType);
    }

    setSubmitting(true);
    setError('');
    try {
      await onCreate({
        description: taskDescription,
        model: taskModel,
        directory: taskDirectory,
        trigger,
      });
      setDescription('');
      switch (trigger.type) {
        case 'quota':
          break;
        case 'time':
          setScheduledAt('');
          break;
        case 'task':
          setPredecessorId('');
          break;
        default:
          assertNever(trigger);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel task-create" aria-labelledby="task-create-title">
      <header className="task-section-head">
        <div>
          <h2 id="task-create-title">新建任务</h2>
          <p>在服务主机上按条件执行一次 OpenCode 任务。</p>
        </div>
      </header>

      <form className="task-form" aria-busy={submitting} noValidate onSubmit={submit}>
        <div className="task-form-grid">
          <label className="field task-field task-field-wide">
            <span>任务描述</span>
            <textarea
              required
              rows={4}
              value={description}
              placeholder="说明要让 OpenCode 完成的工作"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>

          <TaskModelField
            value={model}
            discovery={modelDiscovery}
            onChange={setModel}
          />

          <label className="field task-field">
            <span>
              工作目录
              <em className="hint">留空使用服务默认目录</em>
            </span>
            <input
              type="text"
              value={directory}
              placeholder={defaultDirectory || '/path/to/project'}
              spellCheck={false}
              onChange={(event) => onDirectoryChange(event.target.value)}
            />
            <small className="task-field-note">
              当前默认：<code>{defaultDirectory || '加载中'}</code>
            </small>
          </label>

          <label className="field task-field">
            <span>触发条件</span>
            <select
              value={triggerType}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'quota' || value === 'time' || value === 'task') setTriggerType(value);
              }}
            >
              <option value="quota">有可用额度时</option>
              <option value="time">指定本地时间</option>
              <option value="task">等待其他任务完成</option>
            </select>
          </label>

          {triggerType === 'time' && (
            <label className="field task-field">
              <span>执行时刻</span>
              <input
                required
                type="datetime-local"
                min={localDateTime(Date.now() + 60_000)}
                value={scheduledAt}
                onChange={(event) => setScheduledAt(event.target.value)}
              />
            </label>
          )}

          {triggerType === 'task' && (
            <label className="field task-field">
              <span>前置任务</span>
              <select
                required
                value={predecessorId}
                aria-describedby={predecessorHintId}
                onChange={(event) => setPredecessorId(event.target.value)}
              >
                <option value="">{tasks.length === 0 ? '暂无可选任务，请先创建前置任务' : '请选择前置任务'}</option>
                {predecessorId !== '' && !predecessorAvailable && (
                  <option value={predecessorId} disabled>已不可用 · {predecessorId}</option>
                )}
                {tasks.map((task) => (
                  <option key={task.id} value={task.id} title={task.id}>
                    {task.description} · {task.id.slice(0, 8)}
                  </option>
                ))}
              </select>
              <small id={predecessorHintId} className="task-field-note">
                前置任务成功、失败或取消后均会触发；已完成的任务会立即满足条件。
              </small>
            </label>
          )}
        </div>

        {error && (
          <p className="task-feedback task-feedback-error" role="alert">
            {error}
          </p>
        )}

        <div className="task-submit-row">
          <span className="task-submit-hint">触发器仅启动一轮，不会自动重试。</span>
          <button className="primary" type="submit" disabled={submitting}>
            {submitting ? '正在创建…' : '创建任务'}
          </button>
        </div>
      </form>

      <aside className="task-guide" aria-labelledby="task-guide-title">
        <h3 id="task-guide-title">运行方式</h3>
        <ul>
          <li>额度触发每 60 秒检查一次；任一未禁用且符合 include / exclude 筛选的托管账户满足条件就会放行。</li>
          <li>额度触发只判断条件，不会自动同步认证；执行使用 OpenCode 已配置的凭证。</li>
          <li>任务在服务主机的所选目录运行；不同任务 ID 可并行，应用不设置跨任务并发上限。</li>
          <li>每个任务 ID 同时只运行一轮，初始执行不会自动重试；完成且会话可用后可独立追加消息。</li>
          <li>服务重启会恢复待执行任务；重启时仍在运行的任务会标记为失败。</li>
          <li><code>opencode</code> 必须已安装并在服务进程的 PATH 中；权限遵循 OpenCode 配置，不会传 <code>--auto</code>。</li>
        </ul>
      </aside>
    </section>
  );
}
