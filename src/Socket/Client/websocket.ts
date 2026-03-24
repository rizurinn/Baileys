import { DEFAULT_ORIGIN } from '../../Defaults/index.js'
import { AbstractSocketClient } from './types.js'

export class WebSocketClient extends AbstractSocketClient {
	protected socket: WebSocket | null = null

	get isOpen(): boolean {
		return this.socket?.readyState === WebSocket.OPEN
	}
	get isClosed(): boolean {
		return this.socket === null || this.socket?.readyState === WebSocket.CLOSED
	}
	get isClosing(): boolean {
		return this.socket === null || this.socket?.readyState === WebSocket.CLOSING
	}
	get isConnecting(): boolean {
		return this.socket?.readyState === WebSocket.CONNECTING
	}

	connect() {
		if (this.socket) {
			return
		}

		const headers = {
			Origin: DEFAULT_ORIGIN,
			...(this.config.options?.headers || {})
		}

		// TypeScript's default DOM typings don't officially support the second options object
		// like headers in the WebSocket constructor, so we cast it as 'any' to bypass TS errors.
		// Bun's internal WebSocket implementation will parse this object correctly.
		this.socket = new WebSocket(this.url, {
			headers
		} as any)

		this.socket.onopen = event => {
			this.emit('open', event)
		}

		this.socket.onmessage = event => {
			this.emit('message', event.data)
		}

		this.socket.onerror = event => {
			this.emit('error', event)
		}

		this.socket.onclose = event => {
			this.emit('close', event.code, event.reason)
		}

		// Native WebSockets do not have built-in timeout parameters,
		// so we implement a manual timeout logic as per your JS example.
		if (this.config.connectTimeoutMs) {
			const timeout = setTimeout(() => {
				if (this.socket?.readyState === WebSocket.CONNECTING) {
					void this.close() // <-- Tambahkan 'void' di sini
					this.emit('error', new Error('Connection timeout'))
				}
			}, this.config.connectTimeoutMs)

			const originalOnOpen = this.socket.onopen
			this.socket.onopen = event => {
				clearTimeout(timeout)
				if (originalOnOpen && this.socket) originalOnOpen.call(this.socket, event)
			}
		}
	}

	async close(): Promise<void> {
		if (!this.socket) {
			return
		}

		if (this.socket.readyState === WebSocket.CLOSED) {
			this.socket = null
			return
		}

		const closePromise = new Promise<void>(resolve => {
			if (this.socket) {
				const originalOnClose = this.socket.onclose
				this.socket.onclose = event => {
					// Call the original close emitter so Baileys knows it closed
					if (originalOnClose && this.socket) originalOnClose.call(this.socket, event)
					resolve()
				}
			} else {
				resolve()
			}
		})

		this.socket.close()

		await closePromise

		this.socket = null
	}

	send(str: string | Uint8Array, cb?: (err?: Error) => void): boolean {
		if (this.socket?.readyState !== WebSocket.OPEN) {
			if (cb) cb(new Error('WebSocket is not open'))
			return false
		}

		try {
			this.socket.send(str)
			if (cb) cb()
			return true
		} catch (error) {
			if (cb) cb(error as Error)
			return false
		}
	}
}
