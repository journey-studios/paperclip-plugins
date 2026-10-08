export class BridgeError extends Error {
	constructor(code, status, message = code, headers = {}) {
		super(message);
		this.code = code;
		this.status = status;
		this.headers = headers;
	}
}
