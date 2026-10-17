import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
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
  const triggerId = useId();
  const listId = useId();
  const statusId = useId();
  const pickerRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef(new Map<number, HTMLDivElement>());
  const interactionActive = useRef(false);
  const [customSelected, setCustomSelected] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [models, setModels] = useState(discovery.response?.models ?? null);

  useEffect(() => {
    if (!interactionActive.current) setModels(discovery.response?.models ?? null);
  }, [discovery.response]);

  const custom = customSelected;
  const modelOptions = models === null || models.includes(value)
    ? models ?? [value]
    : [value, ...models];
  const options = [...modelOptions, CUSTOM_MODEL];
  const selectedValue = custom ? CUSTOM_MODEL : value;
  const selectedIndex = Math.max(options.indexOf(selectedValue), 0);
  const safeActiveIndex = Math.min(activeIndex, options.length - 1);

  const status = discovery.loading
    ? '正在读取当前目录的 OpenCode 模型…'
    : discovery.error !== ''
      ? `模型列表获取失败：${discovery.error}。仍可使用当前模型或输入自定义模型。`
      : discovery.response === null
        ? '打开任务页后会读取当前目录的 OpenCode 模型。'
        : `已从 ${discovery.response.directory} 读取 ${models?.length ?? 0} 个模型。`;

  const closePicker = () => {
    setPickerOpen(false);
    interactionActive.current = false;
    setModels(discovery.response?.models ?? null);
  };

  const openPicker = () => {
    interactionActive.current = true;
    setActiveIndex(selectedIndex);
    setPickerOpen(true);
  };

  const chooseModel = (model: string) => {
    if (model === CUSTOM_MODEL) {
      setCustomSelected(true);
    } else {
      setCustomSelected(false);
      onChange(model);
    }
    closePicker();
  };

  const moveActive = (index: number) => {
    setActiveIndex(Math.max(0, Math.min(index, options.length - 1)));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!pickerOpen) openPicker();
        else moveActive(safeActiveIndex + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (!pickerOpen) openPicker();
        else moveActive(safeActiveIndex - 1);
        break;
      case 'Home':
        if (pickerOpen) {
          event.preventDefault();
          moveActive(0);
        }
        break;
      case 'End':
        if (pickerOpen) {
          event.preventDefault();
          moveActive(options.length - 1);
        }
        break;
      case 'PageDown':
        if (pickerOpen) {
          event.preventDefault();
          moveActive(safeActiveIndex + 10);
        }
        break;
      case 'PageUp':
        if (pickerOpen) {
          event.preventDefault();
          moveActive(safeActiveIndex - 10);
        }
        break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        if (!pickerOpen) openPicker();
        else chooseModel(options[safeActiveIndex]);
        break;
      }
      case 'Escape':
        if (pickerOpen) {
          event.preventDefault();
          closePicker();
        }
        break;
    }
  };

  useEffect(() => {
    if (!pickerOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) closePicker();
    };
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, [pickerOpen, discovery.response]);

  useEffect(() => {
    if (pickerOpen) optionRefs.current.get(safeActiveIndex)?.scrollIntoView({ block: 'nearest' });
  }, [pickerOpen, safeActiveIndex]);

  return (
    <div className="field task-field task-model-field" aria-busy={discovery.loading}>
      <label id={labelId} htmlFor={triggerId}>
        <span>
          Provider / Model
          <em className="hint">选择当前目录可用的模型，或使用自定义 provider/model</em>
        </span>
      </label>
      <div className={`task-model-picker${pickerOpen ? ' task-model-picker-open' : ''}`} ref={pickerRef}>
        <button
          id={triggerId}
          className="task-model-trigger"
          type="button"
          role="combobox"
          aria-labelledby={labelId}
          aria-describedby={statusId}
          aria-haspopup="listbox"
          aria-expanded={pickerOpen}
          aria-controls={listId}
          aria-activedescendant={pickerOpen ? `${listId}-option-${safeActiveIndex}` : undefined}
          onFocus={() => {
            interactionActive.current = true;
          }}
          onBlur={() => {
            if (!pickerRef.current?.contains(document.activeElement)) closePicker();
          }}
          onClick={() => {
            if (pickerOpen) closePicker();
            else openPicker();
          }}
          onKeyDown={onKeyDown}
        >
          <span className="task-model-trigger-value">{custom ? '自定义…' : value}</span>
          <span className="task-model-trigger-caret" aria-hidden="true">{pickerOpen ? '▴' : '▾'}</span>
        </button>
        {pickerOpen && (
          <div
            id={listId}
            className="task-model-list"
            role="listbox"
            aria-labelledby={labelId}
          >
            {options.map((model, index) => {
              const isCustom = model === CUSTOM_MODEL;
              const selected = model === selectedValue;
              const active = index === safeActiveIndex;
              return (
                <div
                  key={model}
                  id={`${listId}-option-${index}`}
                  ref={(element) => {
                    if (element === null) optionRefs.current.delete(index);
                    else optionRefs.current.set(index, element);
                  }}
                  role="option"
                  aria-selected={selected}
                  className={`task-model-option${active ? ' task-model-option-active' : ''}${selected ? ' task-model-option-selected' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => moveActive(index)}
                  onClick={() => chooseModel(model)}
                >
                  {isCustom ? '自定义…' : model}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <button
        className="ghost"
        type="button"
        disabled={discovery.loading}
        onClick={() => {
          closePicker();
          discovery.refresh();
        }}
      >
        {discovery.loading ? '正在刷新…' : '刷新模型'}
      </button>
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
