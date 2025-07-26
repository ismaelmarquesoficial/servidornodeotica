// ===================================================
//              IMPORTS DAS BIBLIOTECAS
// ===================================================
import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    useMultiFileAuthState,
    type WASocket,
    type ConnectionState,
    type WAMessage,
    type MessageUpsertType
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import express, { Request, Response } from 'express'
import http from 'http'
import { Server, Socket } from 'socket.io'
import { Storage } from '@google-cloud/storage' // NOVO: Importa o GCS
import fs from 'fs/promises'
import path from 'path'

// ===================================================
//         CONFIGURAÇÃO DO SERVIDOR E GCS
// ===================================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(express.json());

// --- Configuração do Google Cloud Storage ---
const storage = new Storage();
const bucketName = 'substitua-pelo-nome-do-seu-bucket'; // <<< IMPORTANTE: COLOQUE O NOME DO SEU BUCKET AQUI
const bucket = storage.bucket(bucketName);
const authDir = './auth_info_baileys'; // Diretório local temporário

// ===================================================
//         VARIÁVEIS DE ESTADO GLOBAIS
// ===================================================
let sock: WASocket;
let qrCode: string | undefined;
let connectionStatus: ConnectionState['connection'] = 'connecting';

// ===================================================
//         FUNÇÃO DE AUTENTICAÇÃO COM GCS
// ===================================================
async function getAuthStateFromGCS() {
    try {
        await fs.mkdir(authDir, { recursive: true });
        const [files] = await bucket.getFiles();
        console.log(`[GCS] Baixando ${files.length} arquivos de sessão...`);
        for (const file of files) {
            const localPath = path.join(authDir, file.name);
            await file.download({ destination: localPath });
        }
    } catch (error) {
        console.log('[GCS] Nenhuma sessão encontrada ou falha ao baixar. Iniciando nova sessão.');
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    return {
        state,
        saveCreds: async () => {
            await saveCreds(); // Salva localmente primeiro
            try {
                const filesInDir = await fs.readdir(authDir);
                for (const fileName of filesInDir) {
                    const filePath = path.join(authDir, fileName);
                    await bucket.upload(filePath);
                }
                console.log('[GCS] Sessão sincronizada com o Google Cloud Storage.');
            } catch (error) {
                console.error('[GCS] Falha ao sincronizar sessão:', error);
            }
        }
    };
}


// ===================================================
//         FUNÇÃO PRINCIPAL DE CONEXÃO
// ===================================================
async function connectToWhatsApp() {
    // ALTERADO: Usa a nova função de autenticação
    const { state, saveCreds } = await getAuthStateFromGCS();
    
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[VERSÃO] Usando a versão do WhatsApp: ${version.join('.')}, é a mais recente: ${isLatest}`);

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ['Ótica System', 'Chrome', '1.0.0']
    });

    // O resto do seu código de listeners continua igual...
    sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
        const { connection, lastDisconnect, qr } = update;
        if (connection) { connectionStatus = connection; }
        if (qr) {
            qrCode = qr;
            console.log('QR Code gerado, escaneie por favor.');
            io.emit('qr', qrCode);
        }
        if (connection === 'close') {
            const lastError = lastDisconnect?.error as Boom | undefined;
            const statusCode = lastError?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[CONEXÃO] Fechada: ${statusCode}`, ', reconectando:', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            console.log('[CONEXÃO] WhatsApp conectado com sucesso!');
            qrCode = undefined;
        }
        io.emit('connectionUpdate', { status: connectionStatus });
    });

    // ALTERADO: Usa a função saveCreds que sincroniza com o GCS
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', (m: { messages: WAMessage[], type: MessageUpsertType }) => {
        const receivedMessage = m.messages[0];
        if (receivedMessage) {
            console.log(`[MENSAGEM] Recebida de ${receivedMessage.key.remoteJid}`);
            io.emit('newMessage', receivedMessage);
        }
    });
}

// O resto do seu código de API e Socket.io continua igual...
app.get('/status', (req: Request, res: Response) => {
    res.status(200).json({ status: connectionStatus, qr: qrCode });
});
app.post('/messages/send', async (req: Request, res: Response) => {
    const { number, message } = req.body;
    if (connectionStatus !== 'open' || !sock) {
        return res.status(503).json({ success: false, error: 'Serviço indisponível.' });
    }
    if (!number || !message) {
        return res.status(400).json({ success: false, error: 'Número e mensagem são obrigatórios.' });
    }
    try {
        const formattedNumber = `${number}@s.whatsapp.net`;
        await sock.sendMessage(formattedNumber, { text: message });
        res.status(200).json({ success: true, message: 'Mensagem enviada.' });
    } catch (error) {
        console.error("[API ERROR] Falha ao enviar mensagem:", error);
        res.status(500).json({ success: false, error: 'Falha interna.' });
    }
});
io.on('connection', (socket: Socket) => {
    console.log(`[SOCKET.IO] Cliente conectado: ${socket.id}`);
    socket.emit('connectionUpdate', { status: connectionStatus });
    if (qrCode) { socket.emit('qr', qrCode); }
    socket.on('disconnect', () => {
        console.log(`[SOCKET.IO] Cliente desconectado: ${socket.id}`);
    });
});

// ===================================================
//              INICIALIZAÇÃO DO SERVIDOR
// ===================================================
connectToWhatsApp();
const PORT = process.env.PORT || 8080; // Cloud Run usa a porta 8080 por padrão
server.listen(PORT, () => {
    console.log(`[SERVIDOR] API e Socket.io rodando na porta ${PORT}`);
});
