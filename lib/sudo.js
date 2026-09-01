// lib/sudo.js
// Détermine si un numéro fait partie des utilisateurs "sudo"
// (utilisateurs supplémentaires ayant les mêmes droits que le owner).

const config = require('../config');

/**
 * Vérifie si le numéro donné est un utilisateur sudo.
 * Les numéros sudo sont lus depuis config.SUDO_NUMBERS
 * (chaîne séparée par des virgules, ex: "50912345678,50987654321")
 * ou depuis la variable d'environnement SUDO_NUMBERS.
 *
 * @param {string} number - numéro (sans le @s.whatsapp.net)
 * @returns {boolean}
 */
function isSudo(number) {
    if (!number) return false;

    const raw = (config.SUDO_NUMBERS || process.env.SUDO_NUMBERS || '');
    if (!raw) return false;

    const sudoList = raw
        .split(',')
        .map(n => n.trim().replace(/[^0-9]/g, ''))
        .filter(Boolean);

    const cleanNumber = number.replace(/[^0-9]/g, '');
    return sudoList.includes(cleanNumber);
}

module.exports = { isSudo };
