export function textEvidence(text, media, styleVersion) {
 if (!['screen','print'].includes(media))throw new Error('未知媒体');
 return {text:text.normalize('NFC'),media,styleVersion};
}
export function preview(data) {return textEvidence('接收前检查管路','screen',data.styleVersion);}
