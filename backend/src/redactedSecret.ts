import { inspect } from "node:util";

/** Keeps API keys out of ordinary stringification, JSON, and Node diagnostics. */
export class RedactedSecret {
  readonly #value: string;

  /** Wrap a secret at the configuration boundary; do not retain a second plaintext copy. */
  constructor(value: string) {
    this.#value = value;
  }

  /** Unwrap only at the authenticated outbound I/O boundary. */
  reveal(): string {
    return this.#value;
  }

  /** JSON logs never contain the wrapped credential. */
  toJSON(): string {
    return "[REDACTED]";
  }

  /** String interpolation never contains the wrapped credential. */
  toString(): string {
    return "[REDACTED]";
  }

  /** Console inspection never contains the wrapped credential. */
  [inspect.custom](): string {
    return "[REDACTED]";
  }
}
