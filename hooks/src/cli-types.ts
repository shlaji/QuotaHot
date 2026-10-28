export class UsageError extends Error {}

export type Flags = {
  readonly values: Readonly<Record<string, string>>;
  readonly bools: ReadonlySet<string>;
  readonly positional: readonly string[];
};
