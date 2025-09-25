import { io, Socket } from 'socket.io-client';
import { TokenStorage } from '@/auth/tokenStorage';
import { Encryption } from './encryption/encryption';

//
// Types
//

export interface SyncSocketConfig {
    endpoint: string;
    token: string;
}

export interface SyncSocketState {
    isConnected: boolean;
    connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    lastError: Error | null;
}

export type SyncSocketListener = (state: SyncSocketState) => void;

//
// Main Class
//

class ApiSocket {

    // State
    private socket: Socket | null = null;
    private config: SyncSocketConfig | null = null;
    private encryption: Encryption | null = null;
    private messageHandlers: Map<string, (data: any) => void> = new Map();
    private reconnectedListeners: Set<() => void> = new Set();
    private statusListeners: Set<(status: 'disconnected' | 'connecting' | 'connected' | 'error') => void> = new Set();
    private currentStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';

    //
    // Initialization
    //

    initialize(config: SyncSocketConfig, encryption: Encryption) {
        this.config = config;
        this.encryption = encryption;
        this.connect();
    }

    //
    // Connection Management
    //

    connect() {
        if (!this.config || this.socket) {
            console.log('[ApiSocket.connect] Skipping connection', {
                hasConfig: !!this.config,
                hasSocket: !!this.socket
            });
            return;
        }

        console.log('[ApiSocket.connect] Initiating connection to:', this.config.endpoint);
        this.updateStatus('connecting');

        this.socket = io(this.config.endpoint, {
            path: '/v1/updates',
            auth: {
                token: this.config.token,
                clientType: 'user-scoped' as const
            },
            transports: ['websocket'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity
        });

        console.log('[ApiSocket.connect] Socket created, setting up event handlers');
        this.setupEventHandlers();
    }

    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        this.updateStatus('disconnected');
    }

    //
    // Listener Management
    //

    onReconnected = (listener: () => void) => {
        this.reconnectedListeners.add(listener);
        return () => this.reconnectedListeners.delete(listener);
    };

    onStatusChange = (listener: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void) => {
        this.statusListeners.add(listener);
        // Immediately notify with current status
        listener(this.currentStatus);
        return () => this.statusListeners.delete(listener);
    };

    //
    // Message Handling
    //

    onMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.set(event, handler);
        return () => this.messageHandlers.delete(event);
    }

    offMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.delete(event);
    }

    /**
     * RPC call for sessions - uses session-specific encryption
     */
    async sessionRPC<R, A>(sessionId: string, method: string, params: A): Promise<R> {
        const sessionEncryption = this.encryption!.getSessionEncryption(sessionId);
        if (!sessionEncryption) {
            throw new Error(`Session encryption not found for ${sessionId}`);
        }
        
        const result = await this.socket!.emitWithAck('rpc-call', {
            method: `${sessionId}:${method}`,
            params: await sessionEncryption.encryptRaw(params)
        });
        
        if (result.ok) {
            return await sessionEncryption.decryptRaw(result.result) as R;
        }
        throw new Error('RPC call failed');
    }

    /**
     * RPC call for machines - uses legacy/global encryption (for now)
     */
    async machineRPC<R, A>(machineId: string, method: string, params: A): Promise<R> {
        console.log(`[ApiSocket.machineRPC] Starting RPC call:`, {
            machineId,
            method,
            hasSocket: !!this.socket,
            socketConnected: this.socket?.connected,
            hasEncryption: !!this.encryption
        });

        if (!this.socket) {
            console.error('[ApiSocket.machineRPC] Socket is not initialized');
            throw new Error('Socket not initialized');
        }

        if (!this.socket.connected) {
            console.error('[ApiSocket.machineRPC] Socket is not connected', {
                currentStatus: this.currentStatus,
                socketId: this.socket.id
            });
            throw new Error('Socket not connected');
        }

        const machineEncryption = this.encryption!.getMachineEncryption(machineId);
        if (!machineEncryption) {
            console.error(`[ApiSocket.machineRPC] Machine encryption not found:`, {
                machineId,
                hasEncryption: !!this.encryption,
                availableMachines: this.encryption ? 'encrypted' : 'none'
            });
            throw new Error(`Machine encryption not found for ${machineId}`);
        }

        try {
            console.log(`[ApiSocket.machineRPC] Encrypting parameters...`);
            const encryptedParams = await machineEncryption.encryptRaw(params);

            console.log(`[ApiSocket.machineRPC] Emitting RPC call...`, {
                method: `${machineId}:${method}`,
                paramsEncrypted: true
            });

            const result = await this.socket!.emitWithAck('rpc-call', {
                method: `${machineId}:${method}`,
                params: encryptedParams
            });

            console.log(`[ApiSocket.machineRPC] Received response:`, {
                ok: result.ok,
                hasResult: !!result.result,
                error: result.error || null
            });

            if (result.ok) {
                const decrypted = await machineEncryption.decryptRaw(result.result) as R;
                console.log(`[ApiSocket.machineRPC] Successfully decrypted response`);
                return decrypted;
            }

            console.error(`[ApiSocket.machineRPC] RPC call failed:`, {
                result,
                method: `${machineId}:${method}`
            });
            throw new Error(result.error || 'RPC call failed');
        } catch (error) {
            console.error(`[ApiSocket.machineRPC] Exception during RPC:`, {
                error,
                errorMessage: error instanceof Error ? error.message : 'Unknown error',
                errorStack: error instanceof Error ? error.stack : undefined,
                machineId,
                method
            });
            throw error;
        }
    }

    send(event: string, data: any) {
        this.socket!.emit(event, data);
        return true;
    }

    async emitWithAck<T = any>(event: string, data: any): Promise<T> {
        if (!this.socket) {
            console.error('[ApiSocket.emitWithAck] Socket not initialized');
            throw new Error('Socket not connected');
        }

        if (!this.socket.connected) {
            console.error('[ApiSocket.emitWithAck] Socket not connected', {
                event,
                currentStatus: this.currentStatus,
                socketId: this.socket.id
            });
            throw new Error('Socket not connected');
        }

        console.log(`[ApiSocket.emitWithAck] Emitting event: ${event}`);
        try {
            const response = await this.socket.emitWithAck(event, data);
            console.log(`[ApiSocket.emitWithAck] Received response for ${event}`);
            return response;
        } catch (error) {
            console.error(`[ApiSocket.emitWithAck] Error emitting ${event}:`, error);
            throw error;
        }
    }

    //
    // HTTP Requests
    //

    async request(path: string, options?: RequestInit): Promise<Response> {
        if (!this.config) {
            throw new Error('SyncSocket not initialized');
        }

        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            throw new Error('No authentication credentials');
        }

        const url = `${this.config.endpoint}${path}`;
        const headers = {
            'Authorization': `Bearer ${credentials.token}`,
            ...options?.headers
        };

        return fetch(url, {
            ...options,
            headers
        });
    }

    //
    // Token Management
    //

    updateToken(newToken: string) {
        if (this.config && this.config.token !== newToken) {
            this.config.token = newToken;

            if (this.socket) {
                this.disconnect();
                this.connect();
            }
        }
    }

    //
    // Private Methods
    //

    private updateStatus(status: 'disconnected' | 'connecting' | 'connected' | 'error') {
        if (this.currentStatus !== status) {
            console.log(`[ApiSocket] Status change: ${this.currentStatus} -> ${status}`);
            this.currentStatus = status;
            this.statusListeners.forEach(listener => listener(status));
        }
    }

    private setupEventHandlers() {
        if (!this.socket) return;

        // Connection events
        this.socket.on('connect', () => {
            console.log('🔌 [ApiSocket] Connected, recovered: ' + this.socket?.recovered);
            console.log('🔌 [ApiSocket] Socket ID:', this.socket?.id);
            this.updateStatus('connected');
            if (!this.socket?.recovered) {
                this.reconnectedListeners.forEach(listener => listener());
            }
        });

        this.socket.on('disconnect', (reason) => {
            console.log('🔌 [ApiSocket] Disconnected:', reason);
            this.updateStatus('disconnected');
        });

        // Error events
        this.socket.on('connect_error', (error) => {
            console.error('🔌 [ApiSocket] Connection error:', {
                message: error.message,
                type: (error as any).type,
                data: (error as any).data
            });
            this.updateStatus('error');
        });

        this.socket.on('error', (error) => {
            console.error('🔌 [ApiSocket] Socket error:', error);
            this.updateStatus('error');
        });

        // Message handling
        this.socket.onAny((event, data) => {
            // console.log(`📥 SyncSocket: Received event '${event}':`, JSON.stringify(data).substring(0, 200));
            const handler = this.messageHandlers.get(event);
            if (handler) {
                // console.log(`📥 SyncSocket: Calling handler for '${event}'`);
                handler(data);
            } else {
                // console.log(`📥 SyncSocket: No handler registered for '${event}'`);
            }
        });
    }
}

//
// Singleton Export
//

export const apiSocket = new ApiSocket();