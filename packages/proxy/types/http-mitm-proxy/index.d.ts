declare module 'http-mitm-proxy' {
  import type { IncomingMessage, ServerResponse } from 'http';

  export interface ProxyOptions {
    host?: string;
    port?: number;
    sslCaDir?: string;
  }

  export type ErrorCallback = (error?: Error | null, data?: unknown) => void;
  export type DataCallback = (error?: Error | null, chunk?: Buffer) => void;

  export interface ProxyCertificateAuthority {
    getCACertPath(): string;
  }

  export interface IContext {
    readonly isSSL: boolean;
    readonly clientToProxyRequest: IncomingMessage & { httpVersion?: string };
    readonly proxyToClientResponse: ServerResponse;
    readonly proxyToServerRequestOptions?: {
      host?: string;
      port?: number;
    };
    serverToProxyResponse?: IncomingMessage;

    onRequestData(handler: (ctx: IContext, chunk: Buffer, callback: DataCallback) => void): void;
    onRequestEnd(handler: (ctx: IContext, callback: ErrorCallback) => void): void;
    onResponseData(handler: (ctx: IContext, chunk: Buffer, callback: DataCallback) => void): void;
    onResponseEnd(handler: (ctx: IContext, callback: ErrorCallback) => void): void;
  }

  export interface IProxy {
    readonly httpPort: number;
    readonly ca: ProxyCertificateAuthority;
    listen(options: ProxyOptions, callback: () => void): void;
    close(): void;
    onError(handler: (ctx: IContext | null, err?: Error | null, origin?: string) => void): void;
    onRequest(handler: (ctx: IContext, callback: ErrorCallback) => void): void;
  }

  export default function createProxy(): IProxy;
}
