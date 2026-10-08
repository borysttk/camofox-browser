export const sm3 = {
    name: 'SM3',
    detect(source) {
        return /\bSM3\b|sm3\s*\(|0x79cc4519|0x7a879d8a|T1\s*=\s*0x79cc4519|sm3Hash/i.test(source);
    },
};
