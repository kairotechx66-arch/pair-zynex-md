// lib/style.js
// Applique un style de texte (police stylisée) aux réponses du bot.

/**
 * Convertit un texte normal en texte stylisé (petites majuscules "monospace" style).
 * Si aucun mapping n'est trouvé pour un caractère, il est laissé tel quel.
 *
 * @param {string} text - le texte à styliser
 * @returns {string}
 */
function styleReply(text) {
    if (!text) return text;

    const map = {
        a: '𝙰', b: '𝙱', c: '𝙲', d: '𝙳', e: '𝙴', f: '𝙵', g: '𝙶', h: '𝙷',
        i: '𝙸', j: '𝙹', k: '𝙺', l: '𝙻', m: '𝙼', n: '𝙽', o: '𝙾', p: '𝙿',
        q: '𝚀', r: '𝚁', s: '𝚂', t: '𝚃', u: '𝚄', v: '𝚅', w: '𝚆', x: '𝚇',
        y: '𝚈', z: '𝚉',
        A: '𝙰', B: '𝙱', C: '𝙲', D: '𝙳', E: '𝙴', F: '𝙵', G: '𝙶', H: '𝙷',
        I: '𝙸', J: '𝙹', K: '𝙺', L: '𝙻', M: '𝙼', N: '𝙽', O: '𝙾', P: '𝙿',
        Q: '𝚀', R: '𝚁', S: '𝚂', T: '𝚃', U: '𝚄', V: '𝚅', W: '𝚆', X: '𝚇',
        Y: '𝚈', Z: '𝚉'
    };

    return String(text)
        .split('')
        .map(ch => map[ch] || ch)
        .join('');
}

module.exports = { styleReply };
