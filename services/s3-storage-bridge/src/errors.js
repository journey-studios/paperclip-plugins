/** Carries a safe S3 code, HTTP status, and response headers across bridge layers. */
export class BridgeError extends Error {
	/** Preserves the public protocol error separately from the internal message. */
	constructor(code, status, message = code, headers = {}) {
		super(message);
		this.code = code;
		this.status = status;
		this.headers = headers;
	}
}
