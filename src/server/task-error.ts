export class TaskError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503) {
    super(message);
    this.name = 'TaskError';
  }
}
