export const MAX_LINE_BYTES = 1024 * 1024;

/**
 * Incremental reader for newline-delimited JSON on a byte stream (the MCP stdio framing).
 *
 * A client could send an endless line, so the buffer is dropped as soon as it exceeds the limit
 * without a newline, and complete lines above the limit are skipped. Diagnostics are fixed strings
 * so no input text is ever echoed back to stderr.
 *
 * A malformed line is reported and skipped, so one bad message cannot take the stream down.
 */
export function createJsonlReader({ onMessage, onDiagnostic, maxLineBytes = MAX_LINE_BYTES }) {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (buffer.length > maxLineBytes && !buffer.includes(0x0a)) {
        buffer = Buffer.alloc(0);
        onDiagnostic('MCP input exceeded size limit');
        return;
      }
      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (!line.length) continue;
        if (line.length > maxLineBytes) { onDiagnostic('MCP input exceeded size limit'); continue; }
        let message;
        try { message = JSON.parse(line.toString('utf8')); } catch { onDiagnostic('Invalid MCP input'); continue; }
        onMessage(message);
      }
    },
  };
}
