import { execFile } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { TaskError } from './task-error.js';

export function listTaskModels(directory: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('opencode', ['models'], {
      cwd: directory,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        const reason = error.code === 'ENOENT'
          ? 'OpenCode executable was not found on PATH.'
          : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            ? 'OpenCode model output exceeded the 1 MiB limit.'
            : error.killed
              ? 'OpenCode model discovery timed out after 15 seconds.'
              : 'OpenCode model discovery failed.';
        reject(new TaskError(`${reason} Ensure OpenCode is installed and run "opencode models" in the selected directory to check its configuration.`, 503));
        return;
      }
      const models = stripVTControlCharacters(stdout).split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length <= 200 && /^[^\s/\0]+\/[^\s\0]+$/.test(line));
      resolve([...new Set(models)]);
    });
  });
}
