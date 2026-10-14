export const MAX_LINE_BYTES = 1024 * 1024;

/**
 * Incremental reader for newline-delimited JSON on a byte stream (the MCP stdio framing).
 *
 * A client could send an endless line, so the buffer is dropped as soon as it exceeds the limit
 * without a newline, and complete lines above the limit are skipped. Diagnostics are fixed strings
 * so no input text is ever echoed back to stderr.
 *
 * Once a line is known to be oversized, everything up to and including its terminating newline is
 * thrown away, however many chunks that takes. Resuming right after the buffer is dropped would let
 * the tail of the same record, which can itself look like a valid JSON-RPC message, be dispatched.
 *
 * A malformed line is reported and skipped, so one bad message cannot take the stream down.
 */
export function createJsonlReader({ onMessage, onDiagnostic, maxLineBytes = MAX_LINE_BYTES }) {
  let buffer = Buffer.alloc(0);
  let discarding = false;
  return {
    push(chunk) {
      let data = Buffer.from(chunk);
      if (discarding) {
        const end = data.indexOf(0x0a);
        if (end < 0) return;
        data = data.subarray(end + 1);
        discarding = false;
      }
      buffer = Buffer.concat([buffer, data]);
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
      // What is left has no newline yet. If it already exceeds the limit it can never become a valid
      // line, so drop it now rather than buffering an endless record, and skip the rest of that line.
      if (buffer.length > maxLineBytes) {
        buffer = Buffer.alloc(0);
        discarding = true;
        onDiagnostic('MCP input exceeded size limit');
      }
    },
  };
}
