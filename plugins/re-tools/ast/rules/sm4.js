export const sm4 = {
    name: 'SM4',
    detect(source) {
        return /\bSM4\b|sm4(?:Encrypt|Decrypt)|0xd1310ba6|Sbox.*0xd6.*0x90|FK\s*=\s*\[0xa3b1bac6/i.test(source);
    },
};
