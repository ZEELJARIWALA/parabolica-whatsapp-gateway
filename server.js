const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8095;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8090/whatsapp/webhook';

let sock = null;

async function startWhatsApp() {
    console.log("Initializing WhatsApp Connection...");
    
    const { state, saveCreds } = await useMultiFileAuthState('session_auth_info');
    const { version } = await fetchLatestBaileysVersion();
    console.log(`Using WA version: ${version.join('.')}`);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 15000,
        browser: ['Parabolica Bot', 'Chrome', '120.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("\n------------------------------------------------------------------");
            console.log("ACTION REQUIRED: Scan the QR code below using your phone's WhatsApp:");
            console.log("   (Go to WhatsApp > Linked Devices > Link a Device)");
            console.log("------------------------------------------------------------------");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                setTimeout(() => startWhatsApp(), 5000);
            } else {
                console.log("Logged out. Delete 'session_auth_info' folder and restart to scan again.");
            }
        } else if (connection === 'open') {
            console.log("\n=================================================");
            console.log("PARABOLICA WHATSAPP CLIENT IS FULLY CONNECTED!");
            console.log("=================================================\n");
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        console.log(`DEBUG UPSERT: Event type=${m.type}, count=${m.messages?.length}`);
        
        for (const msg of m.messages) {
            const rawKeys = msg.message ? Object.keys(msg.message).join(', ') : 'none';
            console.log(`DEBUG MSG: keys=[${rawKeys}], fromMe=${msg.key.fromMe}, remoteJid=${msg.key.remoteJid}`);

            if (msg.key.fromMe) continue;
            
            const to = msg.key.remoteJid;
            if (!to || (!to.endsWith('@s.whatsapp.net') && !to.endsWith('@lid'))) continue;

            // Forward the full JID as 'phone' to handle both formats seamlessly in DB and replies
            const phone = to;
            const name = msg.pushName || "Pilot";
            
            let text = "";
            const msgContent = msg.message;
            if (msgContent) {
                console.log("DEBUG MSGCONTENT JSON: ", JSON.stringify(msgContent));
                if (msgContent.conversation) {
                    text = msgContent.conversation;
                } else if (msgContent.extendedTextMessage) {
                    text = msgContent.extendedTextMessage.text || '';
                } else if (msgContent.imageMessage) {
                    text = msgContent.imageMessage.caption || '';
                } else if (msgContent.videoMessage) {
                    text = msgContent.videoMessage.caption || '';
                } else if (msgContent.buttonsResponseMessage) {
                    text = msgContent.buttonsResponseMessage.selectedDisplayText || '';
                } else if (msgContent.templateButtonReplyMessage) {
                    text = msgContent.templateButtonReplyMessage.selectedDisplayText || '';
                } else if (msgContent.listResponseMessage) {
                    text = msgContent.listResponseMessage.title || '';
                }
            }

            text = (text || '').trim();
            if (phone && text) {
                console.log(`Received: "${text}" from ${name} (${phone}). Forwarding...`);
                
                try {
                    const res = await fetch(BACKEND_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ phone, name, text })
                    });
                    
                    if (res.ok) {
                        console.log("Forwarded to Python backend successfully.");
                    } else {
                        console.error(`Python API returned: ${res.status}`);
                    }
                } catch (err) {
                    console.error(`Failed forwarding to backend: ${err.message}`);
                }
            }
        }
    });
}

app.post('/send', async (req, res) => {
    const { to, message } = req.body;
    
    if (!to || !message) {
        return res.status(400).json({ error: "Missing 'to' or 'message'" });
    }

    if (!sock) {
        return res.status(500).json({ error: "WhatsApp not connected yet" });
    }

    try {
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        console.log(`Sending to ${jid}: "${message.substring(0, 40)}..."`);
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true });
    } catch (err) {
        console.error(`Send error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.get('/status', (req, res) => {
    res.json({ status: sock ? 'ONLINE' : 'OFFLINE' });
});

app.listen(PORT, () => {
    console.log(`Gateway API running on port ${PORT}`);
    startWhatsApp().catch((err) => console.error("Init Error:", err));
});
