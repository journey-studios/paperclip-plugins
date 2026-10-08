import { readFile } from "node:fs/promises";
import { createBridgeServer } from "./bridge.js";

class StartupConfigError extends Error {}

/** Load mounted secret material without including either the path or contents in diagnostics. */
async function readSecretFile(path, name, { allowMultiline = false } = {}) {
	if (!path) throw new Error(`${name} file path is required`);
	const value = (await readFile(path, "utf8")).trim();
	if (
		!value ||
		(!allowMultiline && /[\r\n]/.test(value)) ||
		value.includes("\0")
	)
		throw new Error(`${name} file is empty or malformed`);
	return value;
}

/** Accept only static default-profile bridge credentials, never provider credentials or profiles. */
function parseDefaultCredentials(contents) {
	if (contents.length > 16 * 1024 || contents.includes("\0"))
		throw new Error("credentials file is malformed");
	const values = new Map();
	let inDefault = false;
	let sawDefault = false;
	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		const section = /^\[([^\]]+)\]$/.exec(line);
		if (section) {
			inDefault = section[1].trim() === "default";
			if (inDefault) {
				if (sawDefault) throw new Error("credentials file is malformed");
				sawDefault = true;
			}
			continue;
		}
		if (!inDefault) continue;
		const entry = /^([a-zA-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
		if (!entry) throw new Error("credentials file is malformed");
		const name = entry[1].toLowerCase();
		if (
			!["aws_access_key_id", "aws_secret_access_key"].includes(name) ||
			values.has(name) ||
			!entry[2]
		) {
			throw new Error("credentials file uses an unsupported profile feature");
		}
		values.set(name, entry[2]);
	}
	const accessKeyId = values.get("aws_access_key_id");
	const secretAccessKey = values.get("aws_secret_access_key");
	if (!sawDefault || !accessKeyId || !secretAccessKey)
		throw new Error("default AWS credentials are missing");
	return {
		accessKeyId,
		secretAccessKey,
	};
}

/** Parse bounded non-secret integer settings and name the bad setting without echoing its value. */
function integerEnv(name, fallback, min, max) {
	const configured = process.env[name];
	if (configured === undefined) return fallback;
	const value = configured.trim();
	if (!/^\d+$/.test(value))
		throw new StartupConfigError(`${name} must be an integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		throw new StartupConfigError(`${name} must be between ${min} and ${max}`);
	}
	return parsed;
}

/** Parse an explicit true/false opt-in; an empty configured value is an error. */
function booleanEnv(name, fallback) {
	const configured = process.env[name];
	if (configured === undefined) return fallback;
	if (configured === "true") return true;
	if (configured === "false") return false;
	throw new StartupConfigError(`${name} must be either true or false`);
}

/** Read credentials and validate every non-secret setting before opening the listener. */
async function main() {
	const port = integerEnv("PAPERCLIP_BRIDGE_PORT", 9000, 1, 65535);
	const maxUploadBytes = integerEnv(
		"PAPERCLIP_BRIDGE_MAX_UPLOAD_BYTES",
		undefined,
		1,
		64 * 1024 * 1024,
	);
	const maxConcurrentRequests = integerEnv(
		"PAPERCLIP_BRIDGE_MAX_CONCURRENT_REQUESTS",
		undefined,
		1,
		16,
	);
	const allowInternalHttp = booleanEnv(
		"PAPERCLIP_BRIDGE_ALLOW_INTERNAL_HTTP",
		false,
	);
	const [credentialsContents, apiKey] = await Promise.all([
		readSecretFile(
			process.env.AWS_SHARED_CREDENTIALS_FILE,
			"AWS shared credentials",
			{ allowMultiline: true },
		),
		readSecretFile(
			process.env.PAPERCLIP_BOARD_API_KEY_FILE,
			"Paperclip board API key",
		),
	]);
	const credentials = parseDefaultCredentials(credentialsContents);
	const server = createBridgeServer({
		pluginBaseUrl: process.env.PAPERCLIP_PLUGIN_BASE_URL,
		apiKey,
		allowInternalHttp,
		...credentials,
		bucket: process.env.PAPERCLIP_BRIDGE_BUCKET ?? "paperclip-native",
		region: process.env.PAPERCLIP_BRIDGE_REGION ?? "us-east-1",
		maxUploadBytes,
		maxConcurrentRequests,
	});
	server.listen(port, "0.0.0.0", () => {
		process.stdout.write(`S3 storage bridge listening on ${port}\n`);
	});
	const shutdown = () => server.close(() => process.exit(0));
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

main().catch((error) => {
	const detail =
		error instanceof StartupConfigError
			? ` ${error.message}.`
			: " Check configuration and mounted secret files.";
	process.stderr.write(`S3 storage bridge startup failed.${detail}\n`);
	process.exitCode = 1;
});
