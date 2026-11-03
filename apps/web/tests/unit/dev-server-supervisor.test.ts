import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import { superviseDevServer } from '../../scripts/dev-server-supervisor.cjs';

function fixture() {
  const children: EventEmitter[] = [];
  const exits: number[] = [];
  const warnings: string[] = [];
  let time = 0;
  const supervisor = superviseDevServer(
    ['entry'],
    {},
    {
      spawn: () => {
        const child = Object.assign(new EventEmitter(), {
          kill: () => child.emit('exit', null, 'SIGTERM'),
        });
        children.push(child);
        return child;
      },
      exit: (code: number) => exits.push(code),
      warn: (message: string) => warnings.push(message),
      now: () => time,
    },
  );
  return {
    children,
    exits,
    warnings,
    supervisor,
    advance: () => {
      time += 300001;
    },
  };
}

it('restarts only Next restart requests, preserving the supervisor until normal exit', () => {
  const f = fixture();
  f.children[0].emit('exit', 77, null);
  expect(f.children).toHaveLength(2);
  expect(f.exits).toEqual([]);
  f.children[1].emit('exit', 2, null);
  expect(f.exits).toEqual([2]);
});
it('limits repeated restarts and allows a new window after stable operation', () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) f.children.at(-1)!.emit('exit', 77, null);
  f.advance();
  f.children.at(-1)!.emit('exit', 77, null);
  expect(f.children).toHaveLength(5);
  for (let i = 0; i < 3; i++) f.children.at(-1)!.emit('exit', 77, null);
  expect(f.children).toHaveLength(7);
  expect(f.exits).toEqual([77]);
});
it('does not restart an intentional stop or a launch failure', () => {
  const f = fixture();
  f.supervisor.stop('SIGTERM');
  expect(f.children).toHaveLength(1);
  expect(f.exits).toEqual([0]);
  const failed = fixture();
  failed.children[0].emit('error', new Error('injected'));
  expect(failed.exits).toEqual([1]);
});
