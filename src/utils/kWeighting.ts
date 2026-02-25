/**
 * K-weighting filter coefficients per ITU-R BS.1770-5.
 *
 * Two cascaded IIR biquads:
 *   Stage 1 — Pre-filter high shelf (+4 dB, models head diffraction)
 *   Stage 2 — RLB high-pass (~38 Hz corner, low-frequency rolloff)
 *
 * Reference coefficients are specified at 48 kHz.  For other sample rates
 * we apply the bilinear transform: invert to analog at fs_ref=48000, then
 * re-discretize at the target sample rate.
 */

export interface BiquadCoeffs {
  b: [number, number, number];
  a: [number, number, number];
}

export interface KWeightCoeffs {
  shelf: BiquadCoeffs;
  highpass: BiquadCoeffs;
}

// Reference coefficients at 48 kHz (from ITU-R BS.1770-5 Table 1)
const REF_SHELF: BiquadCoeffs = {
  b: [1.53512485958697, -2.69169618940638, 1.19839281085285],
  a: [1.0, -1.69065929318241, 0.73248077421585],
};

const REF_HPF: BiquadCoeffs = {
  b: [1.0, -2.0, 1.0],
  a: [1.0, -1.99004745483398, 0.99007225036621],
};

const FS_REF = 48000;

/** Cache computed coefficients by sample rate. */
const coeffCache = new Map<number, KWeightCoeffs>();

/**
 * Convert a digital biquad (z-domain) back to the analog (s-domain) prototype
 * at the reference sample rate, then re-discretize at a new sample rate via
 * the bilinear transform.
 *
 * Bilinear transform: s = (2·fs) × (z − 1) / (z + 1)
 * Inverse:            z = (1 + s/(2·fs)) / (1 − s/(2·fs))
 */
function transformCoeffs(ref: BiquadCoeffs, fsRef: number, fsTarget: number): BiquadCoeffs {
  // If sample rates match, return reference directly
  if (Math.abs(fsRef - fsTarget) < 0.5) {
    return ref;
  }

  const [b0, b1, b2] = ref.b;
  const [a0, a1, a2] = ref.a;

  // Step 1: Invert bilinear transform to get analog coefficients
  // H(z) = (b0 + b1·z^-1 + b2·z^-2) / (a0 + a1·z^-1 + a2·z^-2)
  // Substituting z^-1 = (1 - s·T/2) / (1 + s·T/2) where T = 1/fs
  // and collecting powers of s:

  const Tref = 1 / fsRef;
  const kRef = 2 / Tref; // = 2·fsRef

  // Numerator coefficients in s-domain (after bilinear substitution and collecting)
  // With z^-1 → (kRef - s) / (kRef + s):
  // H(s) = [ b0·(kRef+s)^2 + b1·(kRef+s)(kRef-s) + b2·(kRef-s)^2 ] /
  //         [ a0·(kRef+s)^2 + a1·(kRef+s)(kRef-s) + a2·(kRef-s)^2 ]
  //
  // Expand each:
  // (kRef+s)^2         = kRef^2 + 2·kRef·s + s^2
  // (kRef+s)(kRef-s)   = kRef^2 - s^2
  // (kRef-s)^2         = kRef^2 - 2·kRef·s + s^2

  const kSq = kRef * kRef;

  // s^0 coefficient
  const Bs0 = b0 * kSq + b1 * kSq + b2 * kSq;
  // s^1 coefficient
  const Bs1 = b0 * 2 * kRef - b2 * 2 * kRef;
  // s^2 coefficient
  const Bs2 = b0 - b1 + b2;

  const As0 = a0 * kSq + a1 * kSq + a2 * kSq;
  const As1 = a0 * 2 * kRef - a2 * 2 * kRef;
  const As2 = a0 - a1 + a2;

  // Step 2: Apply bilinear transform at target sample rate
  const Ttgt = 1 / fsTarget;
  const kTgt = 2 / Ttgt; // = 2·fsTarget
  const kTgtSq = kTgt * kTgt;

  // H(z) = [ Bs0 + Bs1·s + Bs2·s^2 ] / [ As0 + As1·s + As2·s^2 ]
  // Substituting s = kTgt · (z-1)/(z+1) and multiplying through by (z+1)^2:

  // Numerator: Bs2·kTgt^2·(z-1)^2 + Bs1·kTgt·(z-1)(z+1) + Bs0·(z+1)^2
  const nb0 = Bs2 * kTgtSq + Bs1 * kTgt + Bs0;
  const nb1 = -2 * Bs2 * kTgtSq + 2 * Bs0;
  const nb2 = Bs2 * kTgtSq - Bs1 * kTgt + Bs0;

  // Denominator: same pattern with A coefficients
  const na0 = As2 * kTgtSq + As1 * kTgt + As0;
  const na1 = -2 * As2 * kTgtSq + 2 * As0;
  const na2 = As2 * kTgtSq - As1 * kTgt + As0;

  // Normalize so a[0] = 1
  return {
    b: [nb0 / na0, nb1 / na0, nb2 / na0],
    a: [1.0, na1 / na0, na2 / na0],
  };
}

/** Get K-weighting coefficients for a given sample rate. Cached. */
export function getKWeightCoeffs(sampleRate: number): KWeightCoeffs {
  const cached = coeffCache.get(sampleRate);
  if (cached) return cached;

  const shelf = transformCoeffs(REF_SHELF, FS_REF, sampleRate);
  const highpass = transformCoeffs(REF_HPF, FS_REF, sampleRate);
  const result = { shelf, highpass };
  coeffCache.set(sampleRate, result);
  return result;
}

/** Evaluate the frequency response magnitude of a biquad at a given frequency.
 *  Returns gain in dB. Used for testing. */
export function biquadMagnitudeDb(coeffs: BiquadCoeffs, freq: number, sampleRate: number): number {
  const w = (2 * Math.PI * freq) / sampleRate;
  const cosw = Math.cos(w);
  const sinw = Math.sin(w);
  const cos2w = Math.cos(2 * w);
  const sin2w = Math.sin(2 * w);

  const [b0, b1, b2] = coeffs.b;
  const [a0, a1, a2] = coeffs.a;

  // H(e^jw) = (b0 + b1·e^-jw + b2·e^-j2w) / (a0 + a1·e^-jw + a2·e^-j2w)
  const numReal = b0 + b1 * cosw + b2 * cos2w;
  const numImag = -(b1 * sinw + b2 * sin2w);
  const denReal = a0 + a1 * cosw + a2 * cos2w;
  const denImag = -(a1 * sinw + a2 * sin2w);

  const numMagSq = numReal * numReal + numImag * numImag;
  const denMagSq = denReal * denReal + denImag * denImag;

  return 10 * Math.log10(numMagSq / denMagSq);
}

/** Combined K-weighting magnitude (shelf + highpass cascaded) in dB. */
export function kWeightMagnitudeDb(freq: number, sampleRate: number): number {
  const coeffs = getKWeightCoeffs(sampleRate);
  return (
    biquadMagnitudeDb(coeffs.shelf, freq, sampleRate) +
    biquadMagnitudeDb(coeffs.highpass, freq, sampleRate)
  );
}
