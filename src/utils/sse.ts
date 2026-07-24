import type { Response } from 'express';

export class SseChannel {
  private res: Response;
  private closed = false;

  constructor(res: Response) {
    this.res = res;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    res.on('close', () => {
      this.closed = true;
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(event: string, data: unknown): void {
    if (this.closed) return;
    this.res.write(`event: ${event}\n`);
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.res.end();
  }
}
