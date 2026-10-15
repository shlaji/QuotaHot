import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const placeholder = '"__QUOTAHOT_COMMAND_ARGS__"';

export function opencodePlugin(command: string | readonly string[]): string {
  const directory = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
  const template = readFileSync(join(directory, 'opencode-plugin-template.js'), 'utf8');
  if (template.split(placeholder).length !== 2) throw new Error('OpenCode plugin template must contain exactly one command placeholder');
  return template.replace(placeholder, JSON.stringify(typeof command === 'string' ? [command] : command));
}
