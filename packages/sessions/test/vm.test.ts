// The attempt's VM (`src/vm.ts`, `native/src/vm.rs`) on the wire: shared-core's
// explicit recovery state machine, fed the bytes Restate would send and read
// back the bytes it would get. Nothing of @restatedev/sessions stands between,
// and no SDK: this is the binding alone.
import { describe, expect, it } from 'vitest';
import { isShutDown, Vm } from '../src/vm.ts';
import { bytes, decode, field, frame, uint } from './wire.ts';
import { drain, startedVm as started, TYPE, types, V8, value } from './vm-support.ts';

describe('the attempt VM on the wire', () => {
  it('negotiates the service protocol and answers a response head', () => {
    const vm = new Vm([{ key: 'content-type', value: V8 }], true);
    expect(vm.getResponseHead()).toEqual({
      statusCode: 200,
      headers: [{ key: 'content-type', value: V8 }],
    });
    expect(vm.state()).toBe('starting');
  });

  it('is ready once the start and the input are in, and gives the input', () => {
    const vm = new Vm([{ key: 'content-type', value: V8 }], true);
    vm.notifyInput(
      frame(TYPE.start, [...bytes(1, [1, 2, 3, 4]), ...bytes(2, 'inv_test'), ...uint(3, 1), ...bytes(6, 'thekey')]),
    );
    expect(vm.isReadyToExecute()).toBe(false);
    vm.notifyInput(frame(TYPE.input, bytes(14, value('"hello"'))));
    expect(vm.isReadyToExecute()).toBe(true);
    const input = vm.input();
    expect(input.invocationId).toBe('inv_test');
    expect(input.key).toBe('thekey');
    expect(Buffer.from(input.input).toString()).toBe('"hello"');
    expect(vm.state()).toBe('running');
  });

  it('a request/response transport fails the invocation at once', () => {
    const vm = new Vm([{ key: 'content-type', value: V8 }], false);
    // Nothing is asked of it: the attempt is over before the handler starts.
    expect(vm.state()).toBe('closed');
    expect(types(vm.takeOutput())).toContain(TYPE.error);
  });

  it('a state value the invocation knows completes at once, asking Restate nothing', () => {
    const vm = started('"hello"', { state: { greeting: '"hi"' } });
    const handle = vm.getState('greeting');
    expect(drain(vm)).toEqual([{ handle, kind: 'success', bytes: Buffer.from('"hi"') }]);
    expect(types(vm.takeOutput())).toEqual([]);
  });

  it('a state value a complete state does not hold completes as void', () => {
    const vm = started('"hello"');
    const handle = vm.getState('missing');
    expect(drain(vm)).toEqual([{ handle, kind: 'void' }]);
    expect(types(vm.takeOutput())).toEqual([]);
  });

  it('a state value of a partial state is read from Restate, and its completion notifies the handle', () => {
    const vm = started('"hello"', { partial: true });
    const handle = vm.getState('greeting', 'greeting');
    // The read went out as an ephemeral get, and nothing is ready yet.
    const output = vm.takeOutput();
    expect(types(output)).toEqual([TYPE.getStateEphemeral]);
    expect(drain(vm)).toEqual([]);
    // Its id on the wire is the VM's, not the handle's: answer the one it asked with.
    const command = decode(output.subarray(8));
    expect(command.get(2)).toEqual([Buffer.from('greeting')]);
    const id = command.get(1)![0] as number;
    vm.notifyInput(frame(TYPE.getStateEphemeralNotification, [...uint(1, id), ...field(5, 2, value('"hi"'))]));
    expect(drain(vm)).toEqual([{ handle, kind: 'success', bytes: Buffer.from('"hi"') }]);
  });

  it('a write asking to be acked is notified when Restate stores it, and one that does not at once', () => {
    const vm = started('"hello"');
    const acked = vm.setState('a', Buffer.from('1'), 'a', true);
    const unacked = vm.setState('b', Buffer.from('2'), 'b', false);
    // The one that does not ask is notified at once; the other waits.
    expect(drain(vm)).toEqual([{ handle: unacked, kind: 'void' }]);
    expect(types(vm.takeOutput())).toEqual([TYPE.setState, TYPE.setState]);
    // Restate acks the first command it was sent.
    vm.notifyInput(frame(TYPE.commandAck, uint(1, 1)));
    expect(drain(vm)).toEqual([{ handle: acked, kind: 'void' }]);
  });

  it('a value written by the attempt is read back without asking Restate', () => {
    const vm = started('"hello"', { partial: true });
    vm.setState('greeting', Buffer.from('"hi"'));
    vm.takeOutput();
    drain(vm); // the write, notified at once since it asked for no ack
    const handle = vm.getState('greeting');
    expect(drain(vm)).toEqual([{ handle, kind: 'success', bytes: Buffer.from('"hi"') }]);
    expect(types(vm.takeOutput())).toEqual([]);
  });

  it('the cancel signal shows in isCancelled, with no notification of its own', () => {
    const vm = started('"hello"');
    expect(vm.isCancelled()).toBe(false);
    vm.notifyInput(frame(TYPE.signal, [...uint(2, 1), ...bytes(4, [])]));
    expect(vm.isCancelled()).toBe(true);
    expect(drain(vm)).toEqual([]);
  });

  it('end writes the output and closes the attempt', () => {
    const vm = started('"hello"');
    vm.endSuccess(Buffer.from('"done"'));
    expect(types(vm.takeOutput())).toEqual([TYPE.output, TYPE.end]);
    expect(vm.state()).toBe('closed');
  });

  it('closing the input while the handler runs shuts the attempt down', () => {
    const vm = started('"hello"', { partial: true });
    const handle = vm.getState('greeting');
    vm.takeOutput();
    vm.notifyInputClosed();
    // The read is never answered: taking notifications says the attempt is over.
    let thrown: unknown;
    try {
      drain(vm);
    } catch (error) {
      thrown = error;
    }
    expect(isShutDown(thrown)).toBe(true);
    expect(handle).toBeTypeOf('number');
    expect(vm.state()).toBe('closed');
  });

  it('a handler that fails the attempt writes an error, and ends no invocation', () => {
    const vm = started('"hello"');
    vm.notifyError('the model is down', 'at model.ts:1');
    expect(types(vm.takeOutput())).toEqual([TYPE.error]);
    expect(vm.state()).toBe('closed');
  });
});
