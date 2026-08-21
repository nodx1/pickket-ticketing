export function createSSEStream(signal: AbortSignal) {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    cancel() { controller = null; },
  });

  signal.addEventListener("abort", () => { controller?.close(); controller = null; });

  function send(event: string, data: unknown) {
    if (!controller) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    try { controller.enqueue(encoder.encode(payload)); } catch {}
  }

  function close() { try { controller?.close(); } catch {} controller = null; }

  return { stream, send, close };
}
