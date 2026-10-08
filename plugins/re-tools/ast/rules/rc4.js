export const rc4 = {
    name: 'RC4',
    detect(source) {
        return /\bRC4\b|arcfour|rc4(?:Encrypt|Decrypt|Init)|KSA|PRGA|\bS\[i\]\s*=\s*i\b/i.test(source);
    },
};
