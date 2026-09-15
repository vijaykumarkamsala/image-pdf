const INITIAL_STATE = new Uint32Array([
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19,
]);

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotateRight = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

/** Streaming SHA-256 for large browser-local files without buffering the whole upload. */
export class IncrementalSha256 {
  private readonly state = new Uint32Array(INITIAL_STATE);
  private readonly block = new Uint8Array(64);
  private readonly schedule = new Uint32Array(64);
  private blockLength = 0;
  private bytesHashed = 0;
  private finished = false;

  update(input: Uint8Array): this {
    if (this.finished) throw new Error("SHA-256 digest has already been finalized.");
    this.bytesHashed += input.byteLength;
    let offset = 0;
    while (offset < input.byteLength) {
      const copied = Math.min(64 - this.blockLength, input.byteLength - offset);
      this.block.set(input.subarray(offset, offset + copied), this.blockLength);
      this.blockLength += copied;
      offset += copied;
      if (this.blockLength === 64) {
        this.compress(this.block);
        this.blockLength = 0;
      }
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.finished) throw new Error("SHA-256 digest has already been finalized.");
    this.finished = true;
    const bitLength = this.bytesHashed * 8;
    this.block[this.blockLength] = 0x80;
    this.blockLength += 1;
    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength);
      this.compress(this.block);
      this.blockLength = 0;
    }
    this.block.fill(0, this.blockLength, 56);
    const high = Math.floor(bitLength / 0x1_0000_0000);
    const low = bitLength >>> 0;
    const view = new DataView(this.block.buffer);
    view.setUint32(56, high, false);
    view.setUint32(60, low, false);
    this.compress(this.block);

    const output = new Uint8Array(32);
    const outputView = new DataView(output.buffer);
    for (let index = 0; index < this.state.length; index += 1) {
      outputView.setUint32(index * 4, this.state[index], false);
    }
    return output;
  }

  private compress(block: Uint8Array) {
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1) this.schedule[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const previous15 = this.schedule[index - 15];
      const previous2 = this.schedule[index - 2];
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      this.schedule[index] = (this.schedule[index - 16] + sigma0 + this.schedule[index - 7] + sigma1) >>> 0;
    }

    let a = this.state[0];
    let b = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    let e = this.state[4];
    let f = this.state[5];
    let g = this.state[6];
    let h = this.state[7];
    for (let index = 0; index < 64; index += 1) {
      const upperSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first = (h + upperSigma1 + choice + ROUND_CONSTANTS[index] + this.schedule[index]) >>> 0;
      const upperSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (upperSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");

export function sha256Bytes(bytes: Uint8Array): string {
  return hex(new IncrementalSha256().update(bytes).digest());
}

export async function sha256Blob(blob: Blob, onProgress?: (fraction: number) => void): Promise<string> {
  const hasher = new IncrementalSha256();
  const reader = blob.stream().getReader();
  let read = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    hasher.update(item.value);
    read += item.value.byteLength;
    onProgress?.(blob.size > 0 ? read / blob.size : 1);
  }
  return hex(hasher.digest());
}
