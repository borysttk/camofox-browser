export const aes = {
    name: 'AES',
    detect(source) {
        return /\bAES\b|CryptoJS\.AES|aes(?:Encrypt|Decrypt|CBC|ECB|CTR|GCM)|SubBytes|MixColumns|KeyExpansion|0x63.*0x7c.*0x77|sbox\s*=\s*\[/i.test(source);
    },
};
