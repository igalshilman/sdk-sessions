// Restate's side of an attempt on the explicit recovery VM, for tests: the
// wire messages it sends, and the ones it reads back. Shared by the tests of
// the binding (`vm.test.ts`) and of the driver (`driver.test.ts`).
import { bytes, decode, field, frame, TYPE as WIRE, uint } from './wire.ts';
import { Vm, type VmNotification } from '../src/vm.ts';

/** The message types these tests send, beside the ones wire.ts names. */
export const TYPE = {
  ...WIRE,
  commandAck: 0x0004,
  // On V8 a state value the attempt does not know is read with an ephemeral
  // get, which is not journaled; V7 records one in the journal instead.
  getStateEphemeral: 0x0200,
  getStateEphemeralNotification: 0x0300,
  setState: 0x0403,
  clearState: 0x0404,
  call: 0x040d,
  callCompletion: 0x800d,
  callInvocationIdCompletion: 0x800e,
} as const;

export const V8 = 'application/vnd.restate.invocation.v8';

/** A `Value` message: its content is field 1. */
export const value = (content: string | Uint8Array) => bytes(1, content);

/** A VM, started for `thekey` with `input`, and ready to execute. */
export function startedVm(
  input: unknown,
  { partial = false, state = {} }: { partial?: boolean; state?: Record<string, string> } = {},
): Vm {
  const vm = new Vm([{ key: 'content-type', value: V8 }], true);
  const entries = Object.entries(state).flatMap(([key, v]) => field(4, 2, [...bytes(1, key), ...bytes(2, v)]));
  vm.notifyInput(
    frame(TYPE.start, [
      ...bytes(1, [1, 2, 3, 4]),
      ...bytes(2, 'inv_test'),
      ...uint(3, 1), // known_entries: the input
      ...entries,
      ...(partial ? uint(5, 1) : []),
      ...bytes(6, 'thekey'),
    ]),
  );
  vm.notifyInput(frame(TYPE.input, bytes(14, value(JSON.stringify(input)))));
  return vm;
}

/** Every notification the VM has ready now. */
export function drain(vm: Vm): VmNotification[] {
  const out: VmNotification[] = [];
  for (let n = vm.takeNotification(); n !== null; n = vm.takeNotification()) out.push(n);
  return out;
}

/** The header bit a command sets to ask Restate to ack it once stored. */
export const REQUESTED_ACK = 0x8000;

/** One message of an output buffer: its type, header flags and decoded fields. */
export interface Message {
  type: number;
  /** The header's 16 bits of flags; {@link REQUESTED_ACK} is one of them. */
  flags: number;
  fields: ReturnType<typeof decode>;
}

/** The messages in `output`, in order. */
export function messages(output: Uint8Array): Message[] {
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  const out: Message[] = [];
  for (let at = 0; at < output.length;) {
    const type = view.getUint16(at);
    const flags = view.getUint16(at + 2);
    const length = view.getUint32(at + 4);
    out.push({ type, flags, fields: decode(output.subarray(at + 8, at + 8 + length)) });
    at += 8 + length;
  }
  return out;
}

/** The types of the messages in `output`, in order. */
export const types = (output: Uint8Array): number[] => messages(output).map((m) => m.type);
