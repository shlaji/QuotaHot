import type { TaskSessionMessage, TaskSessionPart, TaskSessionTranscript } from './tasks.js';

export interface TaskTranscriptOptions {
  readonly thinking: boolean;
  readonly toolDetails: boolean;
  readonly assistantMetadata: boolean;
}

export const DEFAULT_TASK_TRANSCRIPT_OPTIONS = {
  thinking: true,
  toolDetails: true,
  assistantMetadata: true,
} as const satisfies TaskTranscriptOptions;

function assertNever(value: never): never {
  throw new TypeError(`Unexpected session content: ${String(value)}`);
}

function formatPart(part: TaskSessionPart, options: TaskTranscriptOptions): string {
  switch (part.type) {
    case 'text': return part.synthetic ? '' : `${part.text}\n\n`;
    case 'reasoning': return options.thinking ? `_Thinking:_\n\n${part.text}\n\n` : '';
    case 'tool': {
      let result = `**Tool: ${part.tool}**\n`;
      if (options.toolDetails && part.input) {
        const input: unknown = JSON.parse(part.input);
        result += `\n**Input:**\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\`\n`;
      }
      if (options.toolDetails) {
        switch (part.status) {
          case 'completed':
            if (part.output) result += `\n**Output:**\n\`\`\`\n${part.output}\n\`\`\`\n`;
            break;
          case 'error':
            if (part.error) result += `\n**Error:**\n\`\`\`\n${part.error}\n\`\`\`\n`;
            break;
          case 'pending':
          case 'running': break;
          default: return assertNever(part.status);
        }
      }
      return result + '\n';
    }
    case 'unsupported': return '';
    default: return assertNever(part);
  }
}

function formatMessage(message: TaskSessionMessage, options: TaskTranscriptOptions): string {
  let result: string;
  switch (message.role) {
    case 'user': result = '## User\n\n'; break;
    case 'assistant': {
      const duration = message.time.completed && message.time.created
        ? ((message.time.completed - message.time.created) / 1000).toFixed(1) + 's' : '';
      const agent = message.agent.replace(/\b\w/g, (character) => character.toUpperCase());
      result = options.assistantMetadata
        ? `## Assistant (${agent} · ${message.modelID}${duration ? ` · ${duration}` : ''})\n\n`
        : '## Assistant\n\n';
      break;
    }
    default: return assertNever(message);
  }
  return result + message.parts.map((part) => formatPart(part, options)).join('');
}

export function formatTaskSessionTranscript(
  transcript: TaskSessionTranscript,
  options: TaskTranscriptOptions = DEFAULT_TASK_TRANSCRIPT_OPTIONS,
): string {
  let result = `# ${transcript.title}\n\n`;
  result += `**Session ID:** ${transcript.sessionId}\n`;
  result += `**Created:** ${new Date(transcript.time.created).toLocaleString()}\n`;
  result += `**Updated:** ${new Date(transcript.time.updated).toLocaleString()}\n\n`;
  result += '---\n\n';
  const messages = [...transcript.messages].sort((first, second) => first.time.created - second.time.created || first.id.localeCompare(second.id));
  for (const message of messages) result += formatMessage(message, options) + '---\n\n';
  return result;
}
