export const hmac = {
    name: 'HMAC',
    detect(source) {
        return /\bHMAC\b|CryptoJS\.HmacSHA|hmac(?:SHA|MD|sign)|ipad.*opad|0x36363636|0x5c5c5c5c/i.test(source);
    },
};
