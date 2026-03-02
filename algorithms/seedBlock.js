const SECRET_KEY = Buffer.from([0x42, 0x1A, 0x7F, 0x3E, 0x9B, 0xC4, 0x55, 0xD2]);

export const generateSeedBlock = (buffer) => {
  const seed = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    seed[i] = buffer[i] ^ SECRET_KEY[i % SECRET_KEY.length];
  }
  return seed;
};

export const recoverFromSeed = (seedBuffer) => {
  return generateSeedBlock(seedBuffer);
};
