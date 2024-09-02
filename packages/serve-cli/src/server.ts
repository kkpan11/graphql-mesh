import { promises as fsPromises } from 'node:fs';
import { createServer as createHTTPServer, type Server } from 'node:http';
import { createServer as createHTTPSServer } from 'node:https';
import type { SecureContextOptions } from 'node:tls';
import type { GatewayRuntime } from '@graphql-mesh/serve-runtime';
import type { Logger } from '@graphql-mesh/types';
import { createAsyncDisposable, getTerminateStack } from '@graphql-mesh/utils';
import { defaultOptions } from './cli.js';

export interface ServerConfig {
  /**
   * Host to listen on.
   *
   * @default '127.0.0.1' on Windows, otherwise '0.0.0.0'
   */
  host?: string;
  /**
   * Port to listen on.
   *
   * @default 4000
   */
  port?: number;
  /**
   * SSL Credentials for the HTTPS Server.
   *
   * If this is provided, Gateway will be over secure HTTPS instead of unsecure HTTP.
   */
  sslCredentials?: ServerConfigSSLCredentials;
  /**
   * The size of the HTTP headers to allow
   *
   * @default 16384
   */
  maxHeaderSize?: number;
}

export interface ServerConfigSSLCredentials {
  key_file_name?: string;
  cert_file_name?: string;
  ca_file_name?: string;
  passphrase?: string;
  dh_params_file_name?: string;
  ssl_ciphers?: string;
  ssl_prefer_low_memory_usage?: boolean;
}

export interface ServerForRuntimeOptions extends ServerConfig {
  log: Logger;
}

export async function startServerForRuntime<
  TContext extends Record<string, any> = Record<string, any>,
>(
  runtime: GatewayRuntime<TContext>,
  {
    log,
    host = defaultOptions.host,
    port = defaultOptions.port,
    sslCredentials,
    maxHeaderSize = 16_384,
  }: ServerForRuntimeOptions,
): Promise<AsyncDisposable> {
  const terminateStack = getTerminateStack();
  terminateStack.use(runtime);
  process.on('message', message => {
    if (message === 'invalidateUnifiedGraph') {
      log.info(`Invalidating Supergraph`);
      runtime.invalidateUnifiedGraph();
    }
  });

  let server: AsyncDisposable;

  const serverOpts: ServerForRuntimeOptions = {
    log,
    host,
    port,
    sslCredentials,
    maxHeaderSize,
  };

  try {
    server = await startuWebSocketsServer(runtime, serverOpts);
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') {
      log.debug('Problem while importing uWebSockets.js', e);
    }
    log.warn('uWebSockets.js is not available currently so the server will fallback to node:http.');

    server = await startNodeHttpServer(runtime, serverOpts);
  }

  terminateStack.use(server);

  return server;
}

async function startuWebSocketsServer(
  /** TODO: type out */
  handler: any,
  opts: ServerForRuntimeOptions,
): Promise<AsyncDisposable> {
  const {
    log,
    host = defaultOptions.host,
    port = defaultOptions.port,
    sslCredentials,
    maxHeaderSize,
  } = opts;
  process.env.UWS_HTTP_MAX_HEADERS_SIZE = maxHeaderSize?.toString();
  return import('uWebSockets.js').then(uWS => {
    const protocol = sslCredentials ? 'https' : 'http';
    const app = sslCredentials ? uWS.SSLApp(sslCredentials) : uWS.App();
    app.any('/*', handler);
    log.info(`Starting server on ${protocol}://${host}:${port}`);
    return new Promise((resolve, reject) => {
      app.listen(host, port, function listenCallback(listenSocket) {
        if (listenSocket) {
          resolve(
            createAsyncDisposable(() => {
              log.info(`Closing ${protocol}://${host}:${port}`);
              app.close();
              return Promise.resolve();
            }),
          );
        } else {
          reject(new Error(`Failed to start server on ${protocol}://${host}:${port}!`));
        }
      });
    });
  });
}

async function startNodeHttpServer(
  /** TODO: type out */
  handler: any,
  opts: ServerForRuntimeOptions,
): Promise<AsyncDisposable> {
  const {
    log,
    host = defaultOptions.host,
    port = defaultOptions.port,
    sslCredentials,
    maxHeaderSize,
  } = opts;
  let server: Server;
  let protocol: string;

  if (sslCredentials) {
    protocol = 'https';
    const sslOptionsForNodeHttp: SecureContextOptions = {};
    if (sslCredentials.ca_file_name) {
      sslOptionsForNodeHttp.ca = await fsPromises.readFile(sslCredentials.ca_file_name);
    }
    if (sslCredentials.cert_file_name) {
      sslOptionsForNodeHttp.cert = await fsPromises.readFile(sslCredentials.cert_file_name);
    }
    if (sslCredentials.dh_params_file_name) {
      sslOptionsForNodeHttp.dhparam = await fsPromises.readFile(sslCredentials.dh_params_file_name);
    }
    if (sslCredentials.key_file_name) {
      sslOptionsForNodeHttp.key = await fsPromises.readFile(sslCredentials.key_file_name);
    }
    if (sslCredentials.passphrase) {
      sslOptionsForNodeHttp.passphrase = sslCredentials.passphrase;
    }
    if (sslCredentials.ssl_ciphers) {
      sslOptionsForNodeHttp.ciphers = sslCredentials.ssl_ciphers;
    }
    if (sslCredentials.ssl_prefer_low_memory_usage) {
      sslOptionsForNodeHttp.honorCipherOrder = true;
    }
    server = createHTTPSServer(sslOptionsForNodeHttp, handler);
  } else {
    protocol = 'http';
    server = createHTTPServer(
      {
        maxHeaderSize,
      },
      handler,
    );
  }

  log.info(`Starting server on ${protocol}://${host}:${port}`);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      log.info(`Server started on ${protocol}://${host}:${port}`);
      resolve(
        createAsyncDisposable(
          () =>
            new Promise<void>(resolve => {
              log.info(`Closing server`);
              server.closeAllConnections();
              server.close(() => {
                log.info(`Server closed`);
                resolve();
              });
            }),
        ),
      );
    });
  });
}