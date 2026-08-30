import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

const { subscribeUiEvents, publishDataChanged } = await import('../../src/web/api/ui-events.js');

describe('UI data-change events', () => {
  it('coalesces a burst of sections into one SSE event', async () => {
    const req = new EventEmitter();
    const writes: string[] = [];
    const res: any = {
      status: () => res,
      set: () => res,
      flushHeaders: () => {},
      write: (chunk: string) => writes.push(chunk),
    };
    subscribeUiEvents(req, res);

    publishDataChanged(['providers']);
    publishDataChanged(['secrets', 'agents']);
    await new Promise(resolve => setTimeout(resolve, 350));

    const events = writes.filter(chunk => chunk.startsWith('event: data-changed'));
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('"sections":["providers","secrets","agents"]');
    req.emit('close');
  });
});

describe('UI data-change events: update-available section', () => {
  it('streams the update-available section to SSE subscribers verbatim', async () => {
    const req = new EventEmitter();
    const writes: string[] = [];
    const res: any = {
      status: () => res,
      set: () => res,
      flushHeaders: () => {},
      write: (chunk: string) => writes.push(chunk),
    };
    subscribeUiEvents(req, res);

    publishDataChanged(['update-available']);
    await new Promise(resolve => setTimeout(resolve, 350));

    const events = writes.filter(chunk => chunk.startsWith('event: data-changed'));
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('"sections":["update-available"]');
    req.emit('close');
  });
});
