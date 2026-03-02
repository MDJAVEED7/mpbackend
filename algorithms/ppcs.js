/******************************************************************
 * PPCS – Privacy Preserving Compressive Sensing
 * Single-file JavaScript implementation (Node.js)
 *
 * Based on:
 * "Privacy-Preserving Sensory Data Recovery" (Chen et al.)
 * Used in PPCS-MAA cloud data recovery systems
 ******************************************************************/

/******************** MATRIX UTILITIES ****************************/

function zeros(r, c) {
  return Array.from({ length: r }, () => Array(c).fill(0));
}

function randomMatrix(r, c) {
  return Array.from({ length: r }, () =>
    Array.from({ length: c }, () => Math.random())
  );
}

function transpose(A) {
  return A[0].map((_, i) => A.map(row => row[i]));
}

function multiply(A, B) {
  const res = zeros(A.length, B[0].length);
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B[0].length; j++) {
      let sum = 0;
      for (let k = 0; k < B.length; k++) {
        sum += A[i][k] * B[k][j];
      }
      res[i][j] = sum;
    }
  }
  return res;
}

function frobeniusNorm(A) {
  return Math.sqrt(A.flat().reduce((s, v) => s + v * v, 0));
}

/******************** KVP ENCRYPTION (fen) ************************/
/*
 * S = fen(A) = KVP(D, ψ)
 */

function KVPEncrypt(A, D, psi) {
  const n = A.length;
  const t = A[0].length;
  const K = D.length;

  const S = zeros(n, t);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < t; j++) {
      let val = psi[0] * A[i][j];
      for (let k = 0; k < K; k++) {
        val += psi[k + 1] * D[k][j];
      }
      S[i][j] = val;
    }
  }
  return S;
}

/******************** COMPRESSIVE SENSING *************************/

function compressiveSensing(S, Phi) {
  return multiply(Phi, S);
}

/******************** LOW-RANK RECOVERY ***************************/
/*
 * Iterative SVD-like approximation
 * Approximates A ≈ U Vᵀ
 */

function lowRankRecover(A, rank = 5, iterations = 50) {
  let U = randomMatrix(A.length, rank);
  let V = randomMatrix(A[0].length, rank);

  for (let i = 0; i < iterations; i++) {
    V = multiply(transpose(A), U);
    U = multiply(A, V);
  }

  return multiply(U, transpose(V));
}

/******************** DECRYPTION (fde) ****************************/
/*
 * Â = fde(Â)
 */

function decrypt(A_hat, psi0) {
  return A_hat.map(row =>
    row.map(v => v / psi0)
  );
}

/******************** PPCS PIPELINE *******************************/

function PPCS(A, options = {}) {
  const {
    rank = 5,
    psi0 = 0.6,
    noiseWeight = 0.2
  } = options;

  const n = A.length;
  const t = A[0].length;

  /* Step 1: Generate public vectors */
  const D = [
    randomMatrix(1, t)[0],
    randomMatrix(1, t)[0]
  ];

  const psi = [psi0, noiseWeight, noiseWeight];

  /* Step 2: Encryption */
  const S = KVPEncrypt(A, D, psi);

  /* Step 3: Compressive Sensing */
  const Phi = randomMatrix(Math.floor(n / 2), n);
  const Y = compressiveSensing(S, Phi);

  /* Step 4: Recovery */
  const A_hat_enc = lowRankRecover(Y, rank);

  /* Step 5: Decryption */
  const A_hat = decrypt(A_hat_enc, psi0);

  return A_hat;
}

/******************** DEMO RUN ************************************/

(function demo() {
  console.log("===== PPCS DEMO =====");

  // Original sensor data
  const A = randomMatrix(40, 25);

  console.log("Original Frobenius Norm:", frobeniusNorm(A).toFixed(4));

  // PPCS Recovery
  const A_recovered = PPCS(A, {
    rank: 6,
    psi0: 0.65,
    noiseWeight: 0.175
  });

  console.log("Recovered Frobenius Norm:", frobeniusNorm(A_recovered).toFixed(4));

  console.log("Recovery Error:",
    frobeniusNorm(
      A.map((row, i) =>
        row.map((v, j) => v - A_recovered[i][j])
      )
    ).toFixed(4)
  );
})();

export { PPCS };