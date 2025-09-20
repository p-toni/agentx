import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { createRequire } from 'node:module';

export interface HarRecordInput {
  readonly startedDateTime: string;
  readonly time: number;
  readonly method: string;
  readonly url: string;
  readonly httpVersion: string;
  readonly requestHeaders: Record<string, string | string[] | undefined>;
  readonly requestBody: Buffer;
  readonly responseStatus: number;
  readonly responseStatusText: string;
  readonly responseHeaders: Record<string, string | string[] | undefined>;
  readonly responseBody: Buffer;
}

export interface HarReplayMatch {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

interface HarLog {
  log: {
    version: '1.2';
    creator: {
      name: string;
      version: string;
    };
    entries: HarEntry[];
  };
}

interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarMessage;
  response: HarMessage & { status: number; statusText: string; httpVersion: string };
  cache: Record<string, unknown>;
  timings: {
    send: number;
    wait: number;
    receive: number;
  };
  comment?: string;
}

interface HarMessage {
  method?: string;
  url?: string;
  httpVersion: string;
  headers: HarHeader[];
  queryString?: HarNameValue[];
  cookies: HarNameValue[];
  headersSize: number;
  bodySize: number;
  postData?: {
    mimeType: string;
    text: string;
    encoding?: string;
  };
  content?: {
    size: number;
    mimeType: string;
    text: string;
    encoding?: string;
  };
}

interface HarHeader {
  name: string;
  value: string;
}

interface HarNameValue {
  name: string;
  value: string;
}

export class HarRecorder {
  private readonly entries: HarEntry[] = [];

  constructor(private readonly options: { creatorName: string; creatorVersion: string }) {}

  record(input: HarRecordInput): void {
    const requestHeaders = toHeaderArray(input.requestHeaders);
    const responseHeaders = toHeaderArray(input.responseHeaders);
    const requestBodyText = bufferToText(input.requestBody);
    const responseBodyText = bufferToText(input.responseBody);
    const responseMimeType = detectMimeType(responseHeaders) ?? 'application/octet-stream';
    const responseContent = {
      size: input.responseBody.length,
      mimeType: responseMimeType,
      text: responseBodyText?.text ?? '',
      ...(responseBodyText?.encoding ? { encoding: responseBodyText.encoding } : {})
    };
    const key = buildEntryKey(input.method, input.url, input.requestBody);

    this.entries.push({
      startedDateTime: input.startedDateTime,
      time: input.time,
      request: {
        method: input.method,
        url: input.url,
        httpVersion: input.httpVersion,
        headers: requestHeaders,
        headersSize: -1,
        bodySize: input.requestBody.length,
        cookies: [],
        queryString: [],
        postData: requestBodyText
          ? {
              mimeType: detectMimeType(requestHeaders) ?? 'application/octet-stream',
              text: requestBodyText.text,
              encoding: requestBodyText.encoding
            }
          : undefined
      },
      response: {
        status: input.responseStatus,
        statusText: input.responseStatusText,
        httpVersion: input.httpVersion,
        headers: responseHeaders,
        headersSize: -1,
        bodySize: input.responseBody.length,
        cookies: [],
        content: responseContent
      },
      cache: {},
      timings: {
        send: 0,
        wait: input.time,
        receive: 0
      },
      comment: key
    });
  }

  async save(filePath: string): Promise<void> {
    const har: HarLog = {
      log: {
        version: '1.2',
        creator: {
          name: this.options.creatorName,
          version: this.options.creatorVersion
        },
        entries: this.entries
      }
    };

    await fs.writeFile(filePath, JSON.stringify(har, null, 2), 'utf8');
  }
}

export class HarReplay {
  private readonly lookup: Map<string, HarEntry>;

  constructor(private readonly har: HarLog) {
    this.lookup = new Map();
    for (const entry of har.log.entries) {
      if (!entry.comment) {
        continue;
      }
      this.lookup.set(entry.comment, entry);
    }
  }

  static async load(filePath: string): Promise<HarReplay> {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as HarLog;
    if (!parsed?.log?.entries) {
      throw new Error(`Invalid HAR file at ${filePath}`);
    }
    return new HarReplay(parsed);
  }

  find(method: string, url: string, body: Buffer): HarReplayMatch | undefined {
    const key = buildEntryKey(method, url, body);
    const entry = this.lookup.get(key);
    if (!entry) {
      return undefined;
    }

    const headers = Object.fromEntries(entry.response.headers.map((header) => [header.name, header.value]));
    const content = entry.response.content;
    const bodyBuffer = content?.encoding === 'base64' && content?.text
      ? Buffer.from(content.text, 'base64')
      : Buffer.from(content?.text ?? '', 'utf8');

    return {
      status: entry.response.status,
      statusText: entry.response.statusText,
      headers,
      body: bodyBuffer
    };
  }
}

function toHeaderArray(headers: Record<string, string | string[] | undefined>): HarHeader[] {
  return Object.entries(headers)
    .flatMap(([name, value]) => {
      if (typeof value === 'undefined') {
        return [];
      }
      if (Array.isArray(value)) {
        return value.map((v) => ({ name, value: v }));
      }
      return { name, value };
    })
    .map((header) => ({
      name: header.name,
      value: header.value
    }));
}

function bufferToText(buffer: Buffer): { text: string; encoding?: 'base64' } | undefined {
  if (buffer.length === 0) {
    return undefined;
  }

  const utf8Text = buffer.toString('utf8');
  const utf8Buffer = Buffer.from(utf8Text, 'utf8');
  const sameContent =
    utf8Buffer.byteLength === buffer.byteLength &&
    utf8Buffer.every((value, index) => value === buffer[index]);

  if (sameContent) {
    return { text: utf8Text };
  }

  return { text: buffer.toString('base64'), encoding: 'base64' };
}

function detectMimeType(headers: HarHeader[]): string | undefined {
  const header = headers.find((item) => item.name.toLowerCase() === 'content-type');
  return header?.value;
}

function buildEntryKey(method: string, url: string, body: Buffer): string {
  const hash = createHash('sha256').update(Uint8Array.from(body)).digest('hex');
  return `${method.toUpperCase()} ${url} ${hash}`;
}

export function harCreatorMeta(packageJsonPath: string): { name: string; version: string } {
  const requireModule = createRequire(__filename);
  const packageJson = requireModule(packageJsonPath) as { name?: string; version?: string };
  return {
    name: packageJson.name ?? basename(packageJsonPath),
    version: packageJson.version ?? '0.0.0'
  };
}
