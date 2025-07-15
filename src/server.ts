// ===================================================
//              IMPORTS DAS BIBLIOTECAS
// ===================================================

// Importações do Baileys, incluindo os tipos necessários
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

// Importações do Servidor Web e de Tempo Real
import express, { Request, Response } from 'express'
import http from 'http'
import { Server, Socket } from 'socket.io'
import qrcode from 'qrcode-terminal'


// ===================================================
//         CONFIGURAÇÃO DO SERVIDOR WEB E SOCKET.IO
// ===================================================

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Em produção, restrinja para o domínio do seu frontend: "http://meufrontend.com"
    }
});
app.use(express.json());


// ===================================================
//         VARIÁVEIS DE ESTADO GLOBAIS
// ===================================================

let sock: WASocket;
let qrCode: string | undefined;
let connectionStatus: ConnectionState['connection'] = 'connecting';


// ===================================================
//         FUNÇÃO PRINCIPAL DE CONEXÃO COM O WHATSAPP
// ===================================================

async function connectToWhatsApp() {
    // Gerencia a autenticação, salvando a sessão em arquivos
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    // Busca a versão mais recente do WhatsApp Web para garantir compatibilidade
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[VERSÃO] Usando a versão do WhatsApp: ${version.join('.')}, é a mais recente: ${isLatest}`);

    // Cria a instância do socket do Baileys
    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }), // Use 'debug' para ver todos os logs do Baileys
        printQRInTerminal: true, // Gera o QR Code no terminal automaticamente
        browser: ['Ótica System', 'Chrome', '1.0.0'] // Simula um navegador para mais segurança
    });

    // ----- LISTENERS DE EVENTOS DO BAILEYS -----

    // Monitora o status da conexão
    sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (connection) {
            connectionStatus = connection;
        }

        if (qr) {
            qrCode = qr;
            console.log('QR Code gerado, escaneie por favor.');
            // Emite o QR Code para o frontend via Socket.io
            io.emit('qr', qrCode);
        }

        if (connection === 'close') {
            const lastError = lastDisconnect?.error as Boom | undefined;
            const statusCode = lastError?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`[CONEXÃO] Fechada: ${statusCode}`, ', reconectando:', shouldReconnect);

            if (shouldReconnect) {
                // Tenta reconectar após 5 segundos
                setTimeout(() => connectToWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            console.log('[CONEXÃO] WhatsApp conectado com sucesso!');
            qrCode = undefined; // Limpa o QR Code após a conexão
        }
        
        // Emite o status atual da conexão para todos os clientes do frontend
        io.emit('connectionUpdate', { status: connectionStatus });
    });

    // Salva as credenciais sempre que forem atualizadas
    sock.ev.on('creds.update', saveCreds);

    // Ouve por novas mensagens
    sock.ev.on('messages.upsert', (m: { messages: WAMessage[], type: MessageUpsertType }) => {
        const receivedMessage = m.messages[0];
        if (receivedMessage) {
            console.log(`[MENSAGEM] Recebida de ${receivedMessage.key.remoteJid}`);
            // Emite a mensagem completa para o frontend
            io.emit('newMessage', receivedMessage);
        }
    });
}


// ===================================================
//         ROTAS DA API (PARA O FRONTEND CHAMAR)
// ===================================================

app.get('/status', (req: Request, res: Response) => {
    res.status(200).json({ 
        status: connectionStatus, 
        qr: qrCode 
    });
});

app.post('/messages/send', async (req: Request, res: Response) => {
    const { number, message } = req.body;

    if (connectionStatus !== 'open' || !sock) {
        return res.status(503).json({ success: false, error: 'Serviço indisponível. WhatsApp não está conectado.' });
    }
    if (!number || !message) {
        return res.status(400).json({ success: false, error: 'O número (number) e a mensagem (message) são obrigatórios.' });
    }

    try {
        const formattedNumber = `${number}@s.whatsapp.net`;
        await sock.sendMessage(formattedNumber, { text: message });
        res.status(200).json({ success: true, message: 'Mensagem enviada com sucesso.' });
    } catch (error) {
        console.error("[API ERROR] Falha ao enviar mensagem:", error);
        res.status(500).json({ success: false, error: 'Falha interna ao enviar mensagem.' });
    }
});


// ===================================================
//         LÓGICA DO SOCKET.IO (PARA ENVIAR EVENTOS)
// ===================================================

io.on('connection', (socket: Socket) => {
    console.log(`[SOCKET.IO] Cliente conectado: ${socket.id}`);

    // Envia o status atual e o QR code (se existir) assim que o cliente conecta
    socket.emit('connectionUpdate', { status: connectionStatus });
    if (qrCode) {
        socket.emit('qr', qrCode);
    }

    socket.on('disconnect', () => {
        console.log(`[SOCKET.IO] Cliente desconectado: ${socket.id}`);
    });
});


// ===================================================
//              INICIALIZAÇÃO DO SERVIDOR
// ===================================================

connectToWhatsApp();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[SERVIDOR] API e Socket.io rodando na porta ${PORT}`);
});