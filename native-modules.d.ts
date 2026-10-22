declare module "*app.bundle.mjs" {
  const bundle: string;
  export default bundle;
}

declare module "b4a" {
  type Encoding = "utf8" | "utf-8" | "hex" | "base64" | "ascii" | "latin1";
  const b4a: {
    alloc(size: number): Uint8Array;
    from(value: string, encoding?: Encoding): Uint8Array;
    from(value: ArrayLike<number>): Uint8Array;
    toString(buf: Uint8Array, encoding?: Encoding): string;
    concat(list: Uint8Array[]): Uint8Array;
    equals(a: Uint8Array, b: Uint8Array): boolean;
    isBuffer(x: unknown): boolean;
    byteLength(value: string | Uint8Array, encoding?: Encoding): number;
  };
  export default b4a;
}

// Shims for two CommonJS packages with no @types, consumed only from backend/*.mjs and one test.
// Loose `any` is deliberate — the test exercises runtime behaviour, not type contracts.
declare module "corestore" {
  const Corestore: any;
  export default Corestore;
}

declare module "hyperdrive" {
  const Hyperdrive: any;
  export default Hyperdrive;
}
