export const base64 = {
    name: 'Base64',
    detect(source) {
        return /\bbtoa\b|\batob\b|base64(?:Encode|Decode|encode|decode)|ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789\+\//.test(source);
    },
};
