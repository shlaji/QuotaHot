import { useRef, type ChangeEvent } from 'react';

interface TokenFileImportProps {
  readonly busy: boolean;
  readonly onFiles: (files: readonly File[]) => void;
}

export function TokenFileImport({ busy, onFiles }: TokenFileImportProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (files.length > 0) onFiles(files);
  };

  return (
    <section className="probe-block">
      <h3>上传 JSON 令牌文件</h3>
      <p className="probe-meta">
        支持 Claude、Codex 的 JSON 对象或对象数组，也支持 cockpit-tools 的 Claude/Codex 导出。Qoder 导出只含元数据，不含可迁移令牌。每次最多 20 个文件，每个不超过 1 MiB；不支持纯文本令牌。
      </p>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        multiple
        hidden
        disabled={busy}
        aria-label="选择 JSON 令牌文件"
        onChange={handleChange}
      />
      <div className="modal-actions">
        <button type="button" className="ghost" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? '正在导入…' : '选择 JSON 文件'}
        </button>
      </div>
    </section>
  );
}
