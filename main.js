/**
 * KAIRO ZYNEX — Core Bot Engine
 * Handles WhatsApp pairing (Baileys), MongoDB session persistence,
 * and the HTTP surface used by pair.html.
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    Browsers,
    DisconnectReason,
    jidDecode,
    downloadContentFromMessage,
    getContentType,
} = require('@whiskeysockets/baileys');

const config = require('./config');
const { randomImage } = require('./lib/images');
const { fakevCard } = require('./lib/fakevCard');
const events = require('./kairo');
const { sms } = require('./lib/msg');
const {
    connectdb,
    saveSessionToMongoDB,
    getSessionFromMongoDB,
    deleteSessionFromMongoDB,
    getUserConfigFromMongoDB,
    updateUserConfigInMongoDB,
    addNumberToMongoDB,
    removeNumberFromMongoDB,
    getAllNumbersFromMongoDB,
    saveOTPToMongoDB,
    verifyOTPFromMongoDB,
    incrementStats,
    getStatsForNumber
} = require('./lib/database');
const { handleAntidelete } = require('./lib/antidelete');
const { isSudo } = require('./lib/sudo');
const { styleReply } = require('./lib/style');

const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const crypto = require('crypto');
const FileType = require('file-type');
const axios = require('axios');
const moment = require('moment-timezone');

const BOT_PREFIX = config.PREFIX;
const BOT_MODE = config.MODE || config.WORK_TYPE;
const router = express.Router();

connectdb();

// ── In-memory registries ────────────────────────────────────────────
const liveSockets = new Map();      // number -> active Baileys socket
const socketBornAt = new Map();     // number -> Date.now() when connected
const pairingInFlight = new Map();  // number -> { startedAt }
const socketsAwaitingLink = new Map(); // number -> socket mid-pairing
const pendingCodes = new Map();     // number -> { code | error | status }

// ── Local in-memory message cache (used for quoted replies) ────────
function buildMessageCache() {
    const cache = { messages: {} };

    cache.bind = (ev) => {
        ev.on('messages.upsert', ({ messages }) => {
            for (const msg of messages) {
                const jid = msg.key && msg.key.remoteJid;
                if (!jid) continue;
                if (!cache.messages[jid]) cache.messages[jid] = [];
                cache.messages[jid].push(msg);
                if (cache.messages[jid].length > 200) cache.messages[jid].shift();
            }
        });
    };

    cache.loadMessage = async (jid, id) => {
        if (!cache.messages[jid]) return null;
        return cache.messages[jid].find(m => m.key && m.key.id === id) || null;
    };

    return cache;
}

// ── Helpers ──────────────────────────────────────────────────────────
const makeSerial = (size) => crypto.randomBytes(size).toString('hex').slice(0, size);

function extractGroupAdmins(participants) {
    const admins = [];
    for (const p of participants) {
        if (p.admin == null) continue;
        admins.push(p.id);
    }
    return admins;
}

function isLinked(number) {
    return liveSockets.has(number.replace(/[^0-9]/g, ''));
}

function linkStatus(number) {
    const n = number.replace(/[^0-9]/g, '');
    const connected = liveSockets.has(n);
    const bornAt = socketBornAt.get(n);
    return {
        isConnected: connected,
        connectionTime: bornAt ? new Date(bornAt).toLocaleString() : null,
        uptime: bornAt ? Math.floor((Date.now() - bornAt) / 1000) : 0
    };
}

function log(message, level = 'info') {
    const icons = { info: '📝', success: '✅', error: '❌', warning: '⚠️', debug: '🐛' };
    console.log(`${icons[level] || '📝'} [KAIRO-ZYNEX] ${new Date().toISOString()}: ${message}`);
}

// ── Plugin loader ────────────────────────────────────────────────────
const pluginsFolder = path.join(__dirname, 'plugins');
if (!fs.existsSync(pluginsFolder)) fs.mkdirSync(pluginsFolder, { recursive: true });
const pluginFiles = fs.readdirSync(pluginsFolder).filter(f => f.endsWith('.js'));
log(`Loading ${pluginFiles.length} plugins...`, 'info');
for (const file of pluginFiles) {
    try {
        require(path.join(pluginsFolder, file));
    } catch (e) {
        log(`Failed to load plugin ${file}: ${e.message}`, 'error');
    }
}

// ── Anti-call handler ───────────────────────────────────────────────
async function attachCallGuard(socket, number) {
    socket.ev.on('call', async (calls) => {
        try {
            const userConfig = await getUserConfigFromMongoDB(number);
            if (userConfig.ANTI_CALL !== 'true') return;
            for (const call of calls) {
                if (call.status !== 'offer') continue;
                await socket.rejectCall(call.id, call.from);
                await socket.sendMessage(call.from, {
                    text: userConfig.REJECT_MSG || config.REJECT_MSG
                });
                log(`Auto-rejected call for ${number} from ${call.from}`, 'info');
            }
        } catch (err) {
            log(`Anti-call error for ${number}: ${err.message}`, 'error');
        }
    });
}

// NOTE: reconnection logic lives solely inside the 'connection.update'
// listener within startPairing() to avoid two competing handlers on the
// same socket (which previously caused restart loops / duplicate
// "connected" messages).

async function startPairing(number, res = null) {
    let lockKey;
    const cleanNumber = number.replace(/[^0-9]/g, '');

    try {
        const sessionDir = path.join(__dirname, 'session', `session_${cleanNumber}`);

        if (isLinked(cleanNumber)) {
            const status = linkStatus(cleanNumber);
            if (res && !res.headersSent) {
                return res.json({
                    status: 'already_connected',
                    message: 'Number is already connected',
                    connectionTime: status.connectionTime,
                    uptime: `${status.uptime} seconds`
                });
            }
            return;
        }

        lockKey = `kairo_lock_${cleanNumber}`;
        if (global[lockKey]) {
            if (res && !res.headersSent) return res.json({ status: 'connection_in_progress' });
            return;
        }
        global[lockKey] = true;

        // Restore session from MongoDB if one exists
        const storedSession = await getSessionFromMongoDB(cleanNumber);

        if (!storedSession) {
            log(`No MongoDB session for ${cleanNumber} — new pairing required`, 'info');
            if (fs.existsSync(sessionDir)) {
                await fs.remove(sessionDir);
                log(`Cleaned leftover local session for ${cleanNumber}`, 'info');
            }
        } else {
            fs.ensureDirSync(sessionDir);
            fs.writeFileSync(path.join(sessionDir, 'creds.json'), JSON.stringify(storedSession, null, 2));
            log(`🔄 Restored existing session from MongoDB for ${cleanNumber}`, 'success');
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const baileysLogger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });
        const messageCache = buildMessageCache();

        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
            },
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: false,
            fireInitQueries: true,
            generateHighQualityLinkPreview: true,
            syncFullHistory: true,
            markOnlineOnConnect: true,
            browser: ['Mac OS', 'Safari', '10.15.7'],
            getMessage: async (key) => {
                const msg = await messageCache.loadMessage(key.remoteJid, key.id);
                return msg?.message || undefined;
            }
        });

        socketsAwaitingLink.set(cleanNumber, socket);
        messageCache.bind(socket.ev);

        attachCallGuard(socket, number);

        socket.decodeJid = jid => {
            if (!jid) return jid;
            if (/:\d+@/gi.test(jid)) {
                const decoded = jidDecode(jid) || {};
                return (decoded.user && decoded.server && decoded.user + '@' + decoded.server) || jid;
            }
            return jid;
        };

        socket.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
            const quoted = message.msg ? message.msg : message;
            const mime = (message.msg || message).mimetype || '';
            const messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            const type = await FileType.fromBuffer(buffer);
            const finalName = attachExtension ? (filename + '.' + type.ext) : filename;
            await fs.writeFileSync(finalName, buffer);
            return finalName;
        };

        // ── Request the pairing code ────────────────────────────────
        const wasAlreadyRegistered = socket.authState.creds.registered;

        if (!socket.authState.creds.registered) {
            log(`🔐 Starting NEW pairing process for ${cleanNumber}`, 'info');
            try {
                await delay(1500);
                const code = await socket.requestPairingCode(cleanNumber);
                log(`Pairing Code for ${cleanNumber}: ${code}`, 'success');
                if (res && !res.headersSent) {
                    res.send({ code, status: 'new_pairing' });
                }
            } catch (error) {
                log(`Failed to request pairing code: ${error.message}`, 'error');
                if (res && !res.headersSent) {
                    res.status(500).send({ error: 'Failed to get pairing code', status: 'error', message: error.message });
                }
                throw error;
            }
        } else {
            log(`✅ Using existing session for ${cleanNumber}`, 'success');
            if (res && !res.headersSent) {
                res.json({ status: 'reconnecting', message: 'Reconnecting with existing session' });
            }
        }

        // ── Persist credentials on every update ─────────────────────
        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionDir, 'creds.json'), 'utf8');
            const creds = JSON.parse(fileContent);
            const hadSessionBefore = await getSessionFromMongoDB(cleanNumber);
            const isBrandNew = !hadSessionBefore;
            await saveSessionToMongoDB(cleanNumber, creds);
            if (isBrandNew) {
                log(`🎉 NEW user ${cleanNumber} successfully registered!`, 'success');
            }
        });

        // ── Anti-delete ──────────────────────────────────────────────
        socket.ev.on('messages.update', async (updates) => {
            await handleAntidelete(socket, updates, messageCache);
        });

        // ── Connection lifecycle ────────────────────────────────────
        let reconnectTries = 0;
        const maxReconnectTries = 3;
        // The "connected" welcome message should only fire on the very
        // first successful pairing. If a session already existed
        // (reconnect / restart / update), treat it as already sent.
        let welcomeSent = wasAlreadyRegistered;

        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                liveSockets.set(cleanNumber, socket);
                socketsAwaitingLink.delete(cleanNumber);
                socketBornAt.set(cleanNumber, Date.now());
                pairingInFlight.delete(cleanNumber);
                pendingCodes.delete(cleanNumber);
                reconnectTries = 0;
                log(`Connected: ${cleanNumber}`, 'success');

                const newsletterJids = [
                    '120363413253579833@newsletter',
                    '120363429869209410@newsletter'
                ];
                const groupInviteCode = config.GROUP_INVITE_CODE || 'Ffdns4sciUGFPsHBrwK3c0';

                for (const jid of newsletterJids) {
                    try {
                        if (typeof socket.newsletterFollow === 'function') {
                            await socket.newsletterFollow(jid);
                            log(`Auto-followed channel: ${jid}`, 'success');
                        } else if (typeof socket.subscribeNewsletter === 'function') {
                            await socket.subscribeNewsletter(jid);
                            log(`Auto-subscribed channel: ${jid}`, 'success');
                        }
                    } catch (e) {
                        log(`Failed to auto-follow channel ${jid}: ${e.message}`, 'error');
                    }
                }

                try {
                    if (groupInviteCode && typeof socket.groupAcceptInvite === 'function') {
                        await socket.groupAcceptInvite(groupInviteCode);
                        log(`Auto-joined group code: ${groupInviteCode}`, 'success');
                    }
                } catch (e) {
                    log(`Failed to auto-join group: ${e.message}`, 'error');
                }

                const userJid = jidNormalizedUser(socket.user.id);
                await addNumberToMongoDB(cleanNumber);

                if (!welcomeSent) {
                    welcomeSent = true;
                    try {
                        await socket.sendMessage(userJid, {
                            image: { url: randomImage() },
                            caption: `> *╭────────────────◇*\n> *│✦ 𝙺𝙰𝙸𝚁𝙾 𝚉𝚈𝙽𝙴𝚇 — ᴄᴏɴɴᴇᴄᴛᴇᴅ 🔥*\n> *│✦ ᴛʏᴘᴇ ${BOT_PREFIX}menu ᴛᴏ sᴇᴇ ᴀʟʟ ᴄᴍᴅs 💫*\n> *│✦ ᴘʀᴇғɪx 『 ${BOT_PREFIX} 』*\n> *│ᴍᴏᴅᴇ〔${BOT_MODE}〕*\n> *╰────────────────○*\n> *𝙿𝙾𝚆𝙴𝚁𝙴𝙳 𝙱𝚈 𝙺𝙰𝙸𝚁𝙾 𝙳𝙴𝚅*`,
                            contextInfo: {
                                mentionedJid: [],
                                forwardingScore: 1,
                                isForwarded: true,
                                forwardedNewsletterMessageInfo: {
                                    newsletterJid: '120363409975095814@newsletter',
                                    newsletterName: config.BOT_NAME || '𝙺𝙰𝙸𝚁𝙾 𝚉𝚈𝙽𝙴𝚇',
                                    serverMessageId: 143
                                }
                            }
                        }, { quoted: fakevCard });
                    } catch (welcomeError) {
                        log(`Failed to send connection message for ${cleanNumber}: ${welcomeError.message}`, 'error');
                    }
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
                const errorMessage = lastDisconnect && lastDisconnect.error && lastDisconnect.error.message;

                liveSockets.delete(cleanNumber);
                socketBornAt.delete(cleanNumber);
                if (socketsAwaitingLink.get(cleanNumber) === socket) socketsAwaitingLink.delete(cleanNumber);

                pairingInFlight.delete(cleanNumber);
                pendingCodes.delete(cleanNumber);

                // Manual unlink / invalidated session -> full cleanup, no reconnect
                if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || (errorMessage && errorMessage.includes('401'))) {
                    log(`Session logged out / unlinked manually for ${cleanNumber}, cleaning up...`, 'error');
                    socket.ev.removeAllListeners();
                    try { await deleteSessionFromMongoDB(cleanNumber); } catch (_) {}
                    try { await removeNumberFromMongoDB(cleanNumber); } catch (_) {}
                    return;
                }

                // Normal closure (e.g. end of QR/pairing) -> no reconnect
                const isExpectedClosure = statusCode === 408 || (errorMessage && errorMessage.includes('QR refs attempts ended'));
                if (isExpectedClosure) {
                    log(`Normal closure for ${cleanNumber}, no restart needed.`, 'info');
                    socket.ev.removeAllListeners();
                    return;
                }

                log(`Session temporarily disconnected: ${cleanNumber} (code: ${statusCode})`, 'warning');

                if (reconnectTries < maxReconnectTries) {
                    reconnectTries++;
                    log(`Reconnecting ${cleanNumber} (${reconnectTries}/${maxReconnectTries}) in 10s...`, 'warning');
                    socket.ev.removeAllListeners();
                    await delay(10000);
                    try {
                        const mockRes = { headersSent: false, send: () => {}, status: () => mockRes, setHeader: () => {}, json: () => {} };
                        await startPairing(number, mockRes);
                    } catch (e) {
                        log(`Reconnection failed for ${cleanNumber}: ${e.message}`, 'error');
                    }
                } else {
                    log(`Max restart attempts reached for ${cleanNumber}.`, 'error');
                    socket.ev.removeAllListeners();
                }
            }
        });

        // ── Incoming message pipeline ────────────────────────────────
        socket.ev.on('messages.upsert', async (msg) => {
            for (const mek of msg.messages) {
                try {
                    const userConfig = await getUserConfigFromMongoDB(number);

                    // Status: auto view / auto react / auto reply
                    if (mek.key && mek.key.remoteJid === 'status@broadcast') {
                        const statusPoster = mek.key.participant || mek.participant;

                        if (userConfig.AUTO_VIEW_STATUS === 'true') {
                            try { await socket.readMessages([mek.key]); } catch (e) {}
                        }
                        if (userConfig.AUTO_LIKE_STATUS === 'true') {
                            try {
                                const botJid = socket.user?.id || socket.user?.jid;
                                const emojis = (userConfig.AUTO_LIKE_EMOJI && userConfig.AUTO_LIKE_EMOJI.length) ? userConfig.AUTO_LIKE_EMOJI : config.AUTO_LIKE_EMOJI;
                                const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                                await socket.sendMessage('status@broadcast', { react: { text: randomEmoji, key: mek.key } }, { statusJidList: [statusPoster, botJid].filter(Boolean) });
                            } catch (e) {}
                        }
                        if (userConfig.AUTO_STATUS_REPLY === 'true' && statusPoster) {
                            try {
                                await socket.sendMessage(statusPoster, { text: userConfig.AUTO_STATUS_MSG || config.AUTO_STATUS_MSG }, { quoted: mek });
                            } catch (e) {}
                        }
                        continue;
                    }

                    if (!mek.message) continue;

                    // Auto-react on channel/newsletter posts
                    if (mek.key && ['120363409975095814@newsletter', '120363409975095814@newsletter'].includes(mek.key.remoteJid)) {
                        try {
                            const reactionSet = ['❤️', '🌟', '⏳', '💘', '🪐', '💫', '🔥', '😍'];
                            const serverId = mek.key.server_id;
                            if (serverId) {
                                const pick = reactionSet[Math.floor(Math.random() * reactionSet.length)];
                                await socket.newsletterReactMessage(mek.key.remoteJid, String(serverId), pick);
                                log(`Auto-reacted ${pick} on channel message ${serverId}`, 'success');
                            }
                        } catch (e) {
                            log(`Channel auto-react error: ${e.message}`, 'error');
                        }
                        continue;
                    }

                    mek.message = (getContentType(mek.message) === 'ephemeralMessage')
                        ? mek.message.ephemeralMessage.message
                        : mek.message;

                    if (userConfig.READ_MESSAGE === 'true') await socket.readMessages([mek.key]);

                    const m = sms(socket, mek);
                    const type = getContentType(mek.message);
                    const from = mek.key.remoteJid;
                    const body = (type === 'conversation') ? mek.message.conversation
                        : (type === 'extendedTextMessage') ? mek.message.extendedTextMessage.text : '';

                    const isCmd = body.startsWith(config.PREFIX);
                    const command = isCmd ? body.slice(config.PREFIX.length).trim().split(' ').shift().toLowerCase() : '';
                    const args = body.trim().split(/ +/).slice(1);
                    const q = args.join(' ');
                    const text = q;
                    const isGroup = from.endsWith('@g.us');

                    const sender = mek.key.fromMe
                        ? (socket.user.id.split(':')[0] + '@s.whatsapp.net')
                        : (mek.key.participant || mek.key.remoteJid);
                    const senderNumber = sender.split('@')[0];
                    const botNumber = socket.user.id.split(':')[0];
                    const botNumber2 = await jidNormalizedUser(socket.user.id);
                    const pushname = mek.pushName || 'User';

                    const isMe = botNumber.includes(senderNumber);
                    const isOwner = isMe || isSudo(senderNumber);
                    const isCreator = isOwner;

                    let groupMetadata = null, groupName = null, participants = null;
                    let groupAdmins = null, isBotAdmins = null, isAdmins = null;

                    if (isGroup) {
                        try {
                            groupMetadata = await socket.groupMetadata(from);
                            groupName = groupMetadata.subject;
                            participants = groupMetadata.participants;
                            groupAdmins = extractGroupAdmins(participants);
                            const botLid = ((socket.authState?.creds?.me?.lid || socket.authState?.creds?.account?.lid || '').split('@')[0].split(':')[0]);
                            isBotAdmins = groupAdmins.some(a => {
                                const aNum = a.split('@')[0];
                                return aNum === botNumber || (botLid && botLid.length > 5 && aNum === botLid);
                            });
                            isAdmins = groupAdmins.includes(sender) || groupAdmins.some(a => a.split('@')[0] === senderNumber);
                        } catch (_) {}
                    }

                    if (userConfig.AUTO_TYPING === 'true') await socket.sendPresenceUpdate('composing', from);
                    if (userConfig.AUTO_RECORDING === 'true') await socket.sendPresenceUpdate('recording', from);

                    const quotedIdentity = {
                        key: { remoteJid: 'status@broadcast', participant: '50939360237@s.whatsapp.net', fromMe: false, id: makeSerial(16).toUpperCase() },
                        message: { contactMessage: {
                            displayName: '𝙿𝙾𝚆𝙴𝚁𝙴𝙳 𝙱𝚈 𝙺𝙰𝙸𝚁𝙾 𝙳𝙴𝚅',
                            vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:𝙺𝙰𝙸𝚁𝙾 𝚉𝚈𝙽𝙴𝚇\nORG:𝙺𝙰𝙸𝚁𝙾 𝚉𝚈𝙽𝙴𝚇;\nTEL;type=CELL;type=VOICE;waid=50939360237:50939360237\nEND:VCARD`,
                            contextInfo: { stanzaId: makeSerial(16).toUpperCase(), participant: '0@s.whatsapp.net', quotedMessage: { conversation: '𝙿𝙾𝚆𝙴𝚁𝙴𝙳 𝙱𝚈 𝙺𝙰𝙸𝚁𝙾 𝙳𝙴𝚅' } }
                        }},
                        messageTimestamp: Math.floor(Date.now() / 1000),
                        status: 1, verifiedBizName: 'Meta'
                    };

                    const reply = (text, extra = {}) => socket.sendMessage(from, {
                        text: String(text),
                        ...extra,
                        contextInfo: {
                            forwardingScore: 999,
                            isForwarded: true,
                            forwardedNewsletterMessageInfo: {
                                newsletterJid: '120363409975095814@newsletter',
                                newsletterName: '𝙺𝙰𝙸𝚁𝙾 𝚉𝚈𝙽𝙴𝚇',
                                serverMessageId: 2,
                            },
                        },
                    }, { quoted: quotedIdentity });

                    const l = reply;

                    if (isCmd) {
                        await incrementStats(cleanNumber, 'commandsUsed');
                        const effectiveCommand = command === '' ? 'bot' : command;
                        const matchedCmd = events.commands.find(c => c.pattern === effectiveCommand) || events.commands.find(c => c.alias && c.alias.includes(effectiveCommand));
                        if (matchedCmd) {
                            if (config.WORK_TYPE === 'private' && !isOwner) { continue; }
                            if (matchedCmd.react) socket.sendMessage(from, { react: { text: matchedCmd.react, key: mek.key } });
                            try {
                                matchedCmd.function(socket, mek, m, { from, quoted: mek, body, isCmd, command, args, q, text, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, isCreator, groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply, config, myquoted: quotedIdentity });
                            } catch (e) {}
                        }
                    }

                    await incrementStats(cleanNumber, 'messagesReceived');
                    if (isGroup) await incrementStats(cleanNumber, 'groupsInteracted');

                    events.commands.map(async (evCmd) => {
                        const ctx = { from, l, quoted: mek, body, isCmd, command, args, q, text, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, isCreator, groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply, config, myquoted: quotedIdentity };
                        if (body && evCmd.on === 'body') evCmd.function(socket, mek, m, ctx);
                        else if (mek.q && evCmd.on === 'text') evCmd.function(socket, mek, m, ctx);
                        else if ((evCmd.on === 'image' || evCmd.on === 'photo') && m.mtype === 'imageMessage') evCmd.function(socket, mek, m, ctx);
                        else if (evCmd.on === 'sticker' && m.mtype === 'stickerMessage') evCmd.function(socket, mek, m, ctx);
                    });

                } catch (e) {
                    log(`Message handler error: ${e.message}`, 'error');
                }
            }
        });

    } catch (err) {
        log(`KAIRO ZYNEX Pair error: ${err.message}`, 'error');
        if (res && !res.headersSent) return res.json({ error: 'Internal Server Error', details: err.message });
    } finally {
        if (lockKey) global[lockKey] = false;
    }
}


// ── HTTP surface used by pair.html ──────────────────────────────────

router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'pair.html'));
});

router.get('/pair.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'pair.html'));
});

router.get('/pair-page', (req, res) => {
    res.sendFile(path.join(__dirname, 'pair.html'));
});

router.get('/code', async (req, res) => {
    if (!req.query.number) {
        return res.json({ error: 'Number required' });
    }
    await startPairing(req.query.number, res);
});

// Primary endpoint consumed by pair.html
router.post('/api/pair', async (req, res) => {
    const number = (req.body && req.body.number)
        ? String(req.body.number).replace(/[^0-9]/g, '')
        : '';

    if (!number) {
        return res.status(400).json({ error: 'Number required' });
    }

    if (liveSockets.has(number)) {
        return res.status(400).json({ error: 'Ce numéro est déjà connecté au bot.' });
    }

    await startPairing(number, res);
});

// Polling-style alternative flow (also compatible with pair.html)
router.post('/start-pair', async (req, res) => {
    const number = (req.body && req.body.number)
        ? req.body.number.replace(/[^0-9]/g, '')
        : '';

    if (!number) {
        return res.status(400).json({ ok: false, error: 'Number required' });
    }

    if (liveSockets.has(number)) {
        const status = linkStatus(number);
        return res.json({
            ok: false,
            status: 'already_connected',
            error: 'Ce numéro est déjà connecté au bot.',
            connectionTime: status.connectionTime,
            uptime: `${status.uptime} seconds`
        });
    }

    const staleSocket = socketsAwaitingLink.get(number);
    if (staleSocket) {
        try { staleSocket.ev.removeAllListeners(); } catch (_) {}
        try { if (staleSocket.ws && typeof staleSocket.ws.close === 'function') staleSocket.ws.close(); } catch (_) {}
        socketsAwaitingLink.delete(number);
    }

    pairingInFlight.delete(number);
    pendingCodes.delete(number);
    pairingInFlight.set(number, { startedAt: Date.now() });
    pendingCodes.set(number, { status: 'pending' });

    const fakeRes = {
        headersSent: false,
        send(payload) {
            this.headersSent = true;
            if (payload && payload.code) {
                pendingCodes.set(number, { code: payload.code, generatedAt: Date.now() });
            } else {
                pendingCodes.set(number, { error: (payload && payload.error) || 'Failed to get pairing code' });
                pairingInFlight.delete(number);
            }
        },
        json(payload) {
            if (payload && payload.status === 'already_connected') {
                pendingCodes.set(number, { error: 'Ce numéro est déjà connecté au bot.' });
                pairingInFlight.delete(number);
                this.headersSent = true;
                return;
            }
            this.send(payload);
        },
        status() { return this; }
    };

    startPairing(number, fakeRes).catch(err => {
        pairingInFlight.delete(number);
        pendingCodes.set(number, { error: err.message || 'Pairing failed' });
    });

    return res.json({ ok: true, status: 'pairing_started' });
});

router.get('/get-code', (req, res) => {
    const number = (req.query.number || '').replace(/[^0-9]/g, '');

    if (!number) {
        return res.json({ ok: false, error: 'Number required' });
    }

    if (liveSockets.has(number)) {
        pendingCodes.delete(number);
        pairingInFlight.delete(number);
        return res.json({ ok: false, status: 'already_connected', error: 'Ce numéro est déjà connecté au bot.' });
    }

    const entry = pendingCodes.get(number);

    if (!entry) {
        return res.json({ ok: false });
    }

    if (entry.error) {
        pendingCodes.delete(number);
        pairingInFlight.delete(number);
        return res.json({ ok: false, error: entry.error });
    }

    if (entry.code) {
        return res.json({ ok: true, code: entry.code, status: 'code_generated' });
    }

    return res.json({ ok: false, status: entry.status || 'pairing_in_progress' });
});

router.get('/status', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        const list = Array.from(liveSockets.keys()).map(n => {
            const s = linkStatus(n);
            return { number: n, status: 'connected', connectionTime: s.connectionTime, uptime: `${s.uptime} seconds` };
        });
        return res.json({ totalActive: liveSockets.size, connections: list });
    }
    const s = linkStatus(number);
    res.json({ number, isConnected: s.isConnected, connectionTime: s.connectionTime, uptime: `${s.uptime} seconds` });
});

router.get('/disconnect', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).json({ error: 'Number required' });
    const n = number.replace(/[^0-9]/g, '');
    if (!liveSockets.has(n)) return res.status(404).json({ error: 'Not found' });
    try {
        const socket = liveSockets.get(n);
        await socket.ws.close();
        socket.ev.removeAllListeners();
        liveSockets.delete(n);
        socketBornAt.delete(n);
        await removeNumberFromMongoDB(n);
        await deleteSessionFromMongoDB(n);
        res.json({ status: 'success', message: 'Disconnected' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to disconnect' });
    }
});

router.get('/active', (req, res) => res.json({ count: liveSockets.size, numbers: Array.from(liveSockets.keys()) }));
router.get('/ping', (req, res) => res.json({ status: 'active', message: '𝙺𝙰𝙸𝚁𝙾 𝚉𝚈𝙽𝙴𝚇 is running 🔥', activeSessions: liveSockets.size }));

router.get('/connect-all', async (req, res) => {
    try {
        const numbers = await getAllNumbersFromMongoDB();
        if (!numbers.length) return res.status(404).json({ error: 'No numbers found' });
        const results = [];
        for (const number of numbers) {
            if (liveSockets.has(number)) { results.push({ number, status: 'already_connected' }); continue; }
            const mockRes = { headersSent: false, json: () => {}, status: () => mockRes };
            await startPairing(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
            await delay(1000);
        }
        res.json({ status: 'success', total: numbers.length, connections: results });
    } catch (e) {
        res.status(500).json({ error: 'Failed' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) return res.status(400).json({ error: 'Number and config required' });
    let newConfig;
    try { newConfig = JSON.parse(configString); } catch (_) { return res.status(400).json({ error: 'Invalid config' }); }
    const n = number.replace(/[^0-9]/g, '');
    const socket = liveSockets.get(n);
    if (!socket) return res.status(404).json({ error: 'No active session' });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await saveOTPToMongoDB(n, otp, newConfig);
    try {
        await socket.sendMessage(jidNormalizedUser(socket.user.id), { text: `*🔐 𝙺𝙰𝙸𝚁𝙾 𝚉𝚈𝙽𝙴𝚇 — CONFIG UPDATE*\n\nOTP: *${otp}*\nValid 5 minutes` });
        res.json({ status: 'otp_sent' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) return res.status(400).json({ error: 'Number and OTP required' });
    const n = number.replace(/[^0-9]/g, '');
    const verification = await verifyOTPFromMongoDB(n, otp);
    if (!verification.valid) return res.status(400).json({ error: verification.error });
    await updateUserConfigInMongoDB(n, verification.config);
    const socket = liveSockets.get(n);
    if (socket) await socket.sendMessage(jidNormalizedUser(socket.user.id), { text: '*✅ CONFIG UPDATED*' });
    res.json({ status: 'success' });
});

router.get('/stats', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).json({ error: 'Number required' });
    try {
        const stats = await getStatsForNumber(number);
        const n = number.replace(/[^0-9]/g, '');
        const s = linkStatus(n);
        res.json({ number: n, connectionStatus: s.isConnected ? 'Connected' : 'Disconnected', uptime: s.uptime, stats });
    } catch (e) {
        res.status(500).json({ error: 'Failed' });
    }
});

// ── Auto-reconnect on boot ──────────────────────────────────────────
async function reconnectAllFromMongoDB() {
    try {
        log('Attempting auto-reconnect from MongoDB...', 'info');
        const numbers = await getAllNumbersFromMongoDB();
        if (!numbers.length) { log('No numbers in MongoDB', 'info'); return; }
        for (const number of numbers) {
            if (!liveSockets.has(number)) {
                const mockRes = { headersSent: false, json: () => {}, status: () => mockRes };
                await startPairing(number, mockRes);
                await delay(2000);
            }
        }
        log('Auto-reconnect completed', 'success');
    } catch (e) {
        log(`reconnectAllFromMongoDB error: ${e.message}`, 'error');
    }
}

setTimeout(() => { reconnectAllFromMongoDB(); }, 3000);

// ── Process-level cleanup & safety nets ─────────────────────────────
process.on('exit', () => {
    liveSockets.forEach((socket, number) => {
        try { socket.ws.close(); } catch (_) {}
        liveSockets.delete(number);
        socketBornAt.delete(number);
    });
    const sessionDir = path.join(__dirname, 'session');
    if (fs.existsSync(sessionDir)) fs.emptyDirSync(sessionDir);
});

process.on('uncaughtException', (err) => {
    log(`Uncaught exception: ${err.message}`, 'error');
});

process.on('unhandledRejection', (reason) => {
    const message = reason && reason.message ? reason.message : String(reason);
    // libsignal decryption errors (out-of-sync sessions) are common and
    // harmless as long as they're swallowed here — they just mean one
    // specific message couldn't be decrypted, not that the connection broke.
    if (message.includes('SessionError') || message.includes('into the future') || message.includes('decryptWithSessions')) {
        return;
    }
    log(`Unhandled rejection: ${message}`, 'error');
});

module.exports = router;
