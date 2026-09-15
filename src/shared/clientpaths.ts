/**
 * 本机客户端凭证的位置，哪些可以由用户改。
 *
 * 这些路径原本写死在各处：每个客户端在本机都有自己的固定位置，绝大多数人不用管。
 * 但固定位置并不总是对的——CODEX_HOME 改过、Qoder 装在别的前缀下、把凭证放在另一块盘上，
 * 都会让默认位置落空，而界面上只能看到一句「本机没有这个路径」。
 *
 * 因此每个来源都留一个覆盖项：留空就用内置默认值，行为与从前完全一致。
 * 这里只放前后端都要认的 key 和文案，默认值要看 homedir()，放在 server/clientpaths.ts。
 */

/** 可以在配置里改位置的来源；与导入来源、同步目标、「本机在用」核对用的是同一套 key。 */
export type ClientPathKey =
  | 'cli-proxy-api'
  | 'codex-cli'
  | 'claude-cli'
  | 'opencode'
  | 'qoder-ide'
  | 'qoder-cli'
  | 'qoder-desktop';

/** 用户填的覆盖值；没填的 key 直接不出现，而不是空串——空串和「没配」在界面上不好区分。 */
export type ClientPaths = Partial<Record<ClientPathKey, string>>;

export interface ClientPathField {
  readonly key: ClientPathKey;
  /** 这个来源在提示里的名字，例如「Codex CLI 需要填绝对路径」。 */
  readonly label: string;
}

/** 收敛和校验都按这个列表遍历；改位置的界面在账户页的导入弹窗里。 */
export const CLIENT_PATH_FIELDS: readonly ClientPathField[] = [
  { key: 'cli-proxy-api', label: 'cli-proxy-api' },
  { key: 'codex-cli', label: 'Codex CLI' },
  { key: 'claude-cli', label: 'Claude Code' },
  { key: 'opencode', label: 'OpenCode' },
  { key: 'qoder-ide', label: 'Qoder IDE' },
  { key: 'qoder-cli', label: 'Qoder CLI' },
  { key: 'qoder-desktop', label: 'Qoder 桌面端' },
];

export const CLIENT_PATH_KEYS: readonly ClientPathKey[] = CLIENT_PATH_FIELDS.map((f) => f.key);

export function isClientPathKey(value: unknown): value is ClientPathKey {
  return CLIENT_PATH_KEYS.includes(value as ClientPathKey);
}
