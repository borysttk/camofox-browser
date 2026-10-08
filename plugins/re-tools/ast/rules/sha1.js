export const sha1 = {
    name: 'SHA1',
    detect(source) {
        return /\bSHA1\b|\bSHA-1\b|CryptoJS\.SHA1|sha1\s*\(|0x67452301|0xefcdab89|0x98badcfe|0x10325476|0xc3d2e1f0/i.test(source);
    },
};
