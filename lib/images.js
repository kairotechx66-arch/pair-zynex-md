// lib/images.js
// Retounen yon imaj o aza pou mesaj "connecté" bòt la voye
// lè yon nimewo fèk konekte ak siksè.

const KAIRO_IMAGES = [
    https://files.catbox.moe/hm1anj.jpg
    https://files.catbox.moe/ilpgxl.jpg
    https://files.catbox.moe/prkkzj.png

function randomImage() {
    return KAIRO_IMAGES[Math.floor(Math.random() * KAIRO_IMAGES.length)];
}

module.exports = { randomImage };
