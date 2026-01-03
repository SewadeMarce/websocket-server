import { WebSocketServer } from 'ws';
import postgres from 'postgres';
import { createServer } from 'http';
import dotenv from 'dotenv';

dotenv.config();

const sql = postgres(process.env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

class ChatWebSocketServer {
  constructor() {
    this.clients = new Map();
    this.userSockets = new Map();
  }

  initialize(server) {
    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws, req) => {
      const clientId = this.generateClientId();
      console.log(`✅ Nouveau client connecté: ${clientId}`);

      // Heartbeat
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message.toString());
          await this.handleMessage(clientId, ws, data);
        } catch (error) {
          console.error('❌ Erreur parsing message:', error);
          this.sendToClient(ws, { 
            type: 'error', 
            message: 'Invalid message format' 
          });
        }
      });

      ws.on('close', () => {
        this.handleDisconnect(clientId);
      });

      ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
      });
    });

    // Heartbeat pour détecter les connexions mortes
    const interval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    this.wss.on('close', () => {
      clearInterval(interval);
    });

    console.log('🚀 WebSocket server initialized');
  }

  async handleMessage(clientId, ws, data) {
    try {
      switch (data.type) {
        case 'auth':
          await this.handleAuth(clientId, ws, data);
          break;
        
        case 'join_conversation':
          await this.handleJoinConversation(clientId, data);
          break;
        
        case 'send_message':
          await this.handleSendMessage(clientId, data);
          break;
        
        case 'typing':
          this.handleTyping(clientId, data);
          break;
        
        case 'message_read':
          await this.handleMessageRead(clientId, data);
          break;

        default:
          console.log(`⚠️ Type de message inconnu: ${data.type}`);
      }
    } catch (error) {
      console.error('❌ Erreur handleMessage:', error);
      this.sendToClient(ws, { 
        type: 'error', 
        message: 'Server error' 
      });
    }
  }

  async handleAuth(clientId, ws, data) {
    const { userId } = data;
    
    console.log(`🔐 Authentification: ${userId}`);

    try {
      const [user] = await sql`
        SELECT id FROM users WHERE id = ${userId}
      `;

      if (!user) {
        this.sendToClient(ws, { 
          type: 'auth_error', 
          message: 'User not found' 
        });
        return;
      }

      const conversations = await sql`
        SELECT conversation_id 
        FROM participants 
        WHERE user_id = ${userId}
      `;

      const conversationIds = new Set(
        conversations.map(c => c.conversation_id)
      );

      this.clients.set(clientId, {
        ws,
        userId,
        conversationIds
      });

      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId).add(clientId);

      this.sendToClient(ws, {
        type: 'auth_success',
        clientId,
        userId,
        conversations: Array.from(conversationIds)
      });

      this.broadcastUserStatus(userId, 'online');

      console.log(`✅ Utilisateur authentifié: ${userId}`);
    } catch (error) {
      console.error('❌ Erreur auth:', error);
      this.sendToClient(ws, { 
        type: 'auth_error', 
        message: 'Authentication failed' 
      });
    }
  }

  async handleJoinConversation(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client) return;

    const { conversationId } = data;
    
    try {
      const [participant] = await sql`
        SELECT * FROM participants 
        WHERE conversation_id = ${conversationId} 
        AND user_id = ${client.userId}
      `;

      if (!participant) {
        this.sendToClient(client.ws, {
          type: 'error',
          message: 'Not a participant of this conversation'
        });
        return;
      }

      client.conversationIds.add(conversationId);
      console.log(`👥 ${client.userId} a rejoint la conversation ${conversationId}`);
    } catch (error) {
      console.error('❌ Erreur join conversation:', error);
    }
  }

  async handleSendMessage(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client) return;

    const { conversationId, content, tempId } = data;

    if (!client.conversationIds.has(conversationId)) {
      this.sendToClient(client.ws, {
        type: 'error',
        message: 'Not a participant of this conversation'
      });
      return;
    }

    try {
      const [message] = await sql`
        INSERT INTO messages (conversation_id, sender_id, content)
        VALUES (${conversationId}, ${client.userId}, ${content})
        RETURNING *
      `;

      const [user] = await sql`
        SELECT username, avatar_url 
        FROM users 
        WHERE id = ${client.userId}
      `;

      const messageData = {
        ...message,
        username: user.username,
        avatar_url: user.avatar_url,
        created_at: message.created_at.toISOString()
      };

      console.log(`💬 Message envoyé dans ${conversationId}`);

      this.broadcastToConversation(conversationId, {
        type: 'new_message',
        message: messageData,
        tempId
      });
    } catch (error) {
      console.error('❌ Erreur send message:', error);
      this.sendToClient(client.ws, {
        type: 'error',
        message: 'Failed to send message'
      });
    }
  }

  handleTyping(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client) return;

    const { conversationId, isTyping } = data;

    if (!client.conversationIds.has(conversationId)) return;

    this.broadcastToConversation(conversationId, {
      type: 'user_typing',
      userId: client.userId,
      conversationId,
      isTyping
    }, clientId);
  }

  async handleMessageRead(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client) return;

    const { messageId, conversationId } = data;

    this.broadcastToConversation(conversationId, {
      type: 'message_read',
      messageId,
      readBy: client.userId,
      timestamp: new Date().toISOString()
    });
  }

  handleDisconnect(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;

    const { userId } = client;
    
    this.clients.delete(clientId);
    
    const userClients = this.userSockets.get(userId);
    if (userClients) {
      userClients.delete(clientId);
      
      if (userClients.size === 0) {
        this.userSockets.delete(userId);
        this.broadcastUserStatus(userId, 'offline');
      }
    }

    console.log(`👋 Client déconnecté: ${clientId}`);
  }

  broadcastToConversation(conversationId, message, excludeClientId) {
    let count = 0;
    this.clients.forEach((client, clientId) => {
      if (
        clientId !== excludeClientId && 
        client.conversationIds.has(conversationId) &&
        client.ws.readyState === 1 // OPEN
      ) {
        this.sendToClient(client.ws, message);
        count++;
      }
    });
    console.log(`📤 Message envoyé à ${count} client(s)`);
  }

  broadcastUserStatus(userId, status) {
    const message = {
      type: 'user_status',
      userId,
      status,
      timestamp: new Date().toISOString()
    };

    this.clients.forEach((client) => {
      if (client.ws.readyState === 1) {
        this.sendToClient(client.ws, message);
      }
    });
  }

  sendToClient(ws, data) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  }

  generateClientId() {
    return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Démarrer le serveur
const PORT = process.env.PORT || 8080;
const server = createServer();
const chatServer = new ChatWebSocketServer();

chatServer.initialize(server);

server.listen(PORT, () => {
  console.log(`🚀 WebSocket server running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}`);
});

// Gestion gracieuse de l'arrêt
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    sql.end();
    process.exit(0);
  });
});