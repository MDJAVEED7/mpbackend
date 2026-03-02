import fs from 'fs';
import path from 'path';

// Backwards-compatible simple XOR-based helpers (kept for demos)
export const splitIntoShards = (buffer, dataShards = 4) => {
  const shardSize = Math.ceil(buffer.length / dataShards);
  const shards = [];

  for (let i = 0; i < dataShards; i++) {
    const start = i * shardSize;
    const shard = Buffer.alloc(shardSize);
    buffer.copy(shard, 0, start, start + shardSize);
    shards.push(shard);
  }
  return shards;
};

export const generateParityShard = (shards) => {
  const size = shards[0].length;
  const parity = Buffer.alloc(size);

  for (let i = 0; i < size; i++) {
    let v = 0;
    for (let s of shards) v ^= s[i];
    parity[i] = v;
  }
  return parity;
};

// ==============================
// Reed-Solomon (Node.js WASM)
// ==============================
let _rsInstance = null;

async function getRS() {
  if (_rsInstance) return _rsInstance;
  try {
    const mod = await import('@subspace/reed-solomon-erasure.wasm');
    const { ReedSolomonErasure } = mod;
    _rsInstance = await ReedSolomonErasure.fromCurrentDirectory();
    return _rsInstance;
  } catch (error) {
    console.error('RS LOAD ERROR:', error.stack || error);
    throw error;
  }
}

/**
 * Encode a buffer into data + parity shards
 * Returns: { shards: Buffer[], shardSize, dataShards, parityShards, fileSize }
 */
export async function encodeRS(fileBuffer, dataShards = 4, parityShards = 2) {
  const rs = await getRS();
  const shardSize = Math.ceil(fileBuffer.length / dataShards);
  const paddedSize = shardSize * dataShards;
  const padded = Buffer.alloc(paddedSize);
  fileBuffer.copy(padded);

  const total = dataShards + parityShards;
  const flat = Buffer.alloc(shardSize * total);
  // copy data shards
  for (let i = 0; i < dataShards; i++) {
    padded.copy(flat, i * shardSize, i * shardSize, (i + 1) * shardSize);
  }

  // Encode parity shards in-place
  await rs.encode(flat, dataShards, parityShards);

  // Slice into chunked buffers
  const shards = [];
  for (let i = 0; i < total; i++) {
    shards.push(Buffer.from(flat.slice(i * shardSize, (i + 1) * shardSize)));
  }

  return {
    shards,
    shardSize,
    dataShards,
    parityShards,
    fileSize: fileBuffer.length,
  };
}

/**
 * Recover file from shard files on disk.
 * Reads shard_{i}.bin or shard_{i} (compat) from shardsDir.
 * Returns a Buffer trimmed to fileSize.
 */
export async function recoverRS(shardsDir, shardSize, fileSize, dataShards = 4, parityShards = 2) {
  const rs = await getRS();
  const total = dataShards + parityShards;
  const flat = Buffer.alloc(shardSize * total);
  const present = new Array(total).fill(false);

  for (let i = 0; i < total; i++) {
    const candidates = [
      path.join(shardsDir, `shard_${i}.bin`),
      path.join(shardsDir, `shard_${i}`),
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const shard = fs.readFileSync(p);
        shard.copy(flat, i * shardSize);
        present[i] = true;
        break;
      }
    }
  }

  // Attempt reconstruction - rs.reconstruct modifies the flat buffer
  await rs.reconstruct(flat, dataShards, parityShards, present);

  // Reassemble file from data shards
  const result = Buffer.alloc(fileSize);
  for (let i = 0; i < fileSize; i++) {
    const shardIndex = Math.floor(i / shardSize);
    const byteIndex = i % shardSize;
    result[i] = flat[shardIndex * shardSize + byteIndex];
  }

  return result;
}

