import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A Cloud Storage endpoint that can be made to misbehave.
 *
 * Every failure assertion in the streaming layer's unit tests is a
 * `PassThrough` emitting an `Error`, which is a shape the real client only
 * produces for the *non-retryable* half of the failure space. The retryable
 * half — any 5xx, which is the routine one — goes down a different path inside
 * the SDK, and a connection that simply stops mid-body produces no event at
 * all. Neither is reachable from a hand-made stream, so this stands between the
 * API and `fake-gcs-server` and answers object reads the way a bucket having a
 * bad day would.
 *
 * Only object *reads* are faulted (`alt=media`), so uploads, metadata and
 * listings keep working and a suite can still put its fixtures in place with
 * the fault armed.
 */
export type StorageFault =
  | { kind: 'none' }
  /** Answers a media read with this status and an error body, like a bucket 5xx. */
  | { kind: 'status'; status: number }
  /**
   * Forwards the headers, delivers `bytes` of the body, then destroys the
   * socket without finishing it — a dropped connection mid-download.
   */
  | { kind: 'truncate'; bytes: number };

export interface StorageFaultProxy {
  /** The endpoint to hand the API as `STORAGE_API_ENDPOINT`. */
  url: string;
  /** Arms a fault for the next object reads. Effective immediately. */
  inject: (fault: StorageFault) => void;
  /** Media reads seen since the last `inject`, whatever the fault did with them. */
  mediaReads: () => number;
  close: () => Promise<void>;
}

export async function startStorageFaultProxy(upstream: string): Promise<StorageFaultProxy> {
  const target = new URL(upstream);
  let fault: StorageFault = { kind: 'none' };
  let mediaReads = 0;

  const server = createServer((incoming, outgoing) => {
    const isMediaRead = (incoming.url ?? '').includes('alt=media');
    if (isMediaRead) {
      mediaReads++;
    }

    if (isMediaRead && fault.kind === 'status') {
      outgoing.writeHead(fault.status, { 'content-type': 'application/xml' });
      outgoing.end(`<Error><Code>${String(fault.status)}</Code></Error>`);
      return;
    }

    const forwarded = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: incoming.url,
        method: incoming.method,
        headers: incoming.headers,
      },
      (answer: IncomingMessage) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        if (isMediaRead && fault.kind === 'truncate') {
          truncate(answer, outgoing, fault.bytes);
          return;
        }
        answer.pipe(outgoing);
      },
    );

    forwarded.on('error', () => outgoing.destroy());
    incoming.pipe(forwarded);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    inject: (next) => {
      fault = next;
      mediaReads = 0;
    },
    mediaReads: () => mediaReads,
    close: () => closeServer(server),
  };
}

/**
 * Writes part of the body and then kills the socket.
 *
 * The `Content-Length` already went out with the headers, so the client is left
 * expecting bytes that will never arrive — which is the point: this is the
 * failure that raises no error anywhere in the Cloud Storage client.
 */
function truncate(answer: IncomingMessage, outgoing: ServerResponse, limit: number): void {
  let sent = 0;
  answer.on('data', (chunk: Buffer) => {
    if (sent >= limit) {
      return;
    }
    outgoing.write(chunk.subarray(0, Math.min(chunk.length, limit - sent)));
    sent += chunk.length;
    if (sent >= limit) {
      answer.destroy();
      setTimeout(() => outgoing.socket?.destroy(), SETTLE_BEFORE_DROP_MS);
    }
  });
}

/**
 * Waited out before the socket dies, so that the drop is the *silent* kind.
 *
 * Killed the instant the first bytes go out, it races the client's own response
 * handling and is sometimes reported as a plain request error — a failure the
 * error branch already covers. Once the response is established and its first
 * bytes have been consumed, `node-fetch@2` swallows the abort and the stream
 * says nothing at all, which is the failure this fault exists to produce.
 */
const SETTLE_BEFORE_DROP_MS = 250;

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Sockets held open by a fault injected above would otherwise keep `close`
    // waiting for a connection that is never coming back.
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
