import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const placeholder = '"__QUOTAHOT_COMMAND_ARGS__"';
const notificationPlaceholder = '"__QUOTAHOT_SESSION_NOTIFY_COMMAND_ARGS__"';

export function opencodePlugin(command: string | readonly string[]): string {
  const directory = import.meta.dirname;
  const template = readFileSync(join(directory, 'opencode-plugin-template.js'), 'utf8');
  if (template.split(placeholder).length !== 2) throw new Error('OpenCode plugin template must contain exactly one command placeholder');
  return template.replace(placeholder, JSON.stringify(typeof command === 'string' ? [command] : command));
}

export function opencodeNotificationPlugin(command: string | readonly string[]): string {
  const directory = import.meta.dirname;
  const template = readFileSync(join(directory, 'opencode-notification-plugin-template.js'), 'utf8');
  if (template.split(notificationPlaceholder).length !== 2) {
    throw new Error('OpenCode notification plugin template must contain exactly one command placeholder');
  }
  return template.replace(notificationPlaceholder, JSON.stringify(typeof command === 'string' ? [command] : command));
}
