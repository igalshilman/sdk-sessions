// Restate's side of an invocation, for tests: the service protocol on the
// wire, written and read by hand. These are the codec — frames, protobuf
// fields and the message types — that the tests of the binding
// (`vm.test.ts`), the driver (`driver.test.ts`), the handler and the endpoint
// build their messages with, and read the attempt's answers back with.

// --- Protocol buffers, as much as the messages here need

const varint = (n: number): number[] => {
  const bytes: number[] = [];
  for (; n > 127; n = Math.floor(n / 128)) bytes.push((n % 128) | 128);
  return [...bytes, n];
};
export const field = (number: number, wire: 0 | 2, payload: number[]) =>
  wire === 0 ? [...varint(number * 8), ...payload] : [...varint(number * 8 + 2), ...varint(payload.length), ...payload];
export const uint = (number: number, value: number) => field(number, 0, varint(value));
export const bytes = (number: number, value: Uint8Array | number[] | string) =>
  field(number, 2, typeof value === 'string' ? [...new TextEncoder().encode(value)] : [...value]);

/** A decoded message: its fields' values by number, a number or the bytes of each. */
export type Fields = Map<number, (number | Uint8Array)[]>;
export function decode(buffer: Uint8Array): Fields {
  const fields: Fields = new Map();
  let at = 0;
  const readVarint = () => {
    let value = 0;
    for (let scale = 1; ; scale *= 128) {
      const byte = buffer[at++]!;
      value += (byte & 127) * scale;
      if (byte < 128) return value;
    }
  };
  while (at < buffer.length) {
    const tag = readVarint();
    const number = Math.floor(tag / 8);
    let value: number | Uint8Array;
    if (tag % 8 === 0) value = readVarint();
    else if (tag % 8 === 2) {
      const length = readVarint();
      value = buffer.subarray(at, at + length);
      at += length;
    } else throw new Error(`wire type ${tag % 8} of field ${number}`);
    fields.set(number, [...(fields.get(number) ?? []), value]);
  }
  return fields;
}
// --- Messages

export const TYPE = {
  start: 0x0000,
  suspension: 0x0001,
  error: 0x0002,
  end: 0x0003,
  proposeRunCompletion: 0x0005,
  awaitingOn: 0x0006,
  proposeRunCompletionAck: 0x0007,
  input: 0x0400,
  output: 0x0401,
  signal: 0xfbff,
} as const;

export const frame = (type: number, body: number[]) => {
  const out = new Uint8Array(8 + body.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, type);
  view.setUint32(4, body.length);
  out.set(body, 8);
  return out;
};
