export const rsa = {
    name: 'RSA',
    detect(source) {
        return /\bRSA\b|rsaEncrypt|rsaDecrypt|BigInteger|modPow|modInverse|publicExponent|privateExponent|\bpkcs[18]\b/i.test(source);
    },
};
