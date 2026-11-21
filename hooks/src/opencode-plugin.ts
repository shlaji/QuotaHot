import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const placeholder = '"__QUOTAHOT_COMMAND_ARGS__"';
const notificationPlaceholder = '"__QUOTAHOT_SESSION_NOTIFY_COMMAND_ARGS__"';
const omoPlaceholder = '"__QUOTAHOT_OMO_COMMAND_ARGS__"';
const recoveryPolicyMarker = '// __QUOTAHOT_RECOVERY_POLICY__';

function inlineRecoveryPolicy(template: string): string {
  if (!template.includes(recoveryPolicyMarker)) return template;
  return template.replace(recoveryPolicyMarker,
    () => readFileSync(join(import.meta.dirname, 'recovery-policy-template.js'), 'utf8'));
}

export function opencodePlugin(command: string | readonly string[]): string {
  const directory = import.meta.dirname;
  const template = readFileSync(join(directory, 'opencode-plugin-template.js'), 'utf8');
  if (template.split(placeholder).length !== 2) throw new Error('OpenCode plugin template must contain exactly one command placeholder');
  return inlineRecoveryPolicy(template).replace(placeholder, JSON.stringify(typeof command === 'string' ? [command] : command));
}

export function opencodeNotificationPlugin(command: string | readonly string[]): string {
  const directory = import.meta.dirname;
  const template = readFileSync(join(directory, 'opencode-notification-plugin-template.js'), 'utf8');
  if (template.split(notificationPlaceholder).length !== 2) {
    throw new Error('OpenCode notification plugin template must contain exactly one command placeholder');
  }
  return template.replace(notificationPlaceholder, JSON.stringify(typeof command === 'string' ? [command] : command));
}

export function omoPlugin(command: string | readonly string[]): string {
  const template = readFileSync(join(import.meta.dirname, 'omo-plugin-template.js'), 'utf8');
  if (template.split(omoPlaceholder).length !== 2) throw new Error('OmO plugin template must contain exactly one command placeholder');
  const marker = '// __QUOTAHOT_OMO_RECOVERY__';
  if (template.split(marker).length > 2) throw new Error('OmO plugin template has duplicate recovery markers');
  const source = template.includes(marker)
    ? template.replace(marker, readFileSync(join(import.meta.dirname, 'omo-recovery-template.js'), 'utf8'))
    : template;
  const statusMarker = '// __QUOTAHOT_OMO_RECOVERY_STATUS__';
  const withStatus = source.includes(statusMarker)
    ? source.replace(statusMarker, readFileSync(join(import.meta.dirname, 'omo-recovery-status-template.js'), 'utf8'))
    : source;
  return inlineRecoveryPolicy(withStatus).replace(omoPlaceholder, JSON.stringify(typeof command === 'string' ? [command] : command));
}
