import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FileWriteDriver,
  type FileWritePayload,
  type FileWriteReceipt,
  HttpPostDriver,
  type HttpPostPayload,
  type HttpPostReceipt,
  createHttpRollbackRegistry,
  Intent,
  Journal,
  type JournalEntry,
  type JournalOptions
} from '../src/index';

const FIXED_DATE = new Date('2024-01-01T00:00:00.000Z');

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (!dir) {
      continue;
    }

    await rm(dir, { recursive: true, force: true });
  }
});

describe('Journal', () => {
  it('appends intents with monotonic ids and idempotency', async () => {
    const workspace = await createWorkspace();
    const journalFile = join(workspace, 'intents.jsonl');
    const targetFile = join(workspace, 'note.txt');
    const journal = new Journal(constantClockOptions(journalFile));
    const driver = new FileWriteDriver();

    const intent: Intent<FileWritePayload, FileWriteReceipt> = {
      type: 'files.write',
      idempotencyKey: 'write-1',
      payload: { path: targetFile, content: 'hello world' }
    };

    const first = await journal.append(intent, driver);
    const second = await journal.append(intent, driver);

    expect(first.id).toBe('000000000001');
    expect(second.id).toBe(first.id);

    const log = await readFile(journalFile, 'utf8');
    const lines = log.trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!) as JournalEntry;
    expect(parsed.status).toBe('committed');
    expect(parsed.idempotencyKey).toBe('write-1');
  });

  it('only appends new entries and keeps ids monotonic', async () => {
    const workspace = await createWorkspace();
    const journalFile = join(workspace, 'intents.jsonl');
    const journal = new Journal(constantClockOptions(journalFile));
    const driver = new FileWriteDriver();

    const intents = ['a', 'b', 'c'].map((suffix) => ({
      type: 'files.write',
      idempotencyKey: `write-${suffix}`,
      payload: { path: join(workspace, `${suffix}.txt`), content: suffix }
    }));

    for (const intent of intents) {
      await journal.append(intent, driver);
    }

    const entries = journal.list();
    expect(entries.map((entry) => entry.id)).toEqual([
      '000000000001',
      '000000000002',
      '000000000003'
    ]);
  });

  it('rolls back failed file writes to the original content', async () => {
    const workspace = await createWorkspace();
    const journalFile = join(workspace, 'intents.jsonl');
    const targetFile = join(workspace, 'note.txt');
    const baselineContent = 'baseline';
    await writeFile(targetFile, baselineContent, 'utf8');

    const journal = new Journal(constantClockOptions(journalFile));
    const driver = new (class extends FileWriteDriver {
      async commit(
        intent: Intent<FileWritePayload, FileWriteReceipt>,
        prepared: Parameters<FileWriteDriver['commit']>[1]
      ) {
        await super.commit(intent, prepared);
        throw new Error('simulated failure');
      }
    })();

    const intent: Intent<FileWritePayload, FileWriteReceipt> = {
      type: 'files.write',
      idempotencyKey: 'write-rollback',
      payload: { path: targetFile, content: 'new-content' }
    };

    await expect(journal.append(intent, driver)).rejects.toThrow('simulated failure');

    const result = await readFile(targetFile, 'utf8');
    expect(result).toBe(baselineContent);

    const entries = journal.list();
    const last = entries.at(-1);
    expect(last?.status).toBe('rolledback');
  });
});

describe('HttpPostDriver', () => {
  it('commits requests with response hash and idempotency key', async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            ok: true,
            received: body,
            idempotency: req.headers['idempotency-key']
          })
        );
      });
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));

    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/`;

    const workspace = await createWorkspace();
    const journal = new Journal(constantClockOptions(join(workspace, 'intents.jsonl')));
    const driver = new HttpPostDriver();
    const intent: Intent<HttpPostPayload, HttpPostReceipt> = {
      type: 'http.post',
      idempotencyKey: 'http-1',
      payload: {
        url,
        body: { hello: 'world' }
      }
    };

    const prepared = await driver.prepare(intent, { journal });
    const receipt = await driver.commit(intent, prepared, { journal });

    expect(receipt.status).toBe(200);
    expect(receipt.idempotencyKey).toBe('http-1');
    expect(receipt.responseHash).toMatch(/^[a-f0-9]{64}$/);

    await driver.rollback(intent, prepared, { journal });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('uses rollback registry rules to delete created resources', async () => {
    let deletedPath: string | null = null;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/messages') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ messageId: 'msg-42' }));
        return;
      }
      if (req.method === 'DELETE') {
        deletedPath = url.pathname;
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/messages`;

    const registry = createHttpRollbackRegistry({
      rules: [
        {
          name: 'message-create',
          host: '127.0.0.1',
          commit: {
            method: 'POST',
            path: '/messages',
            idFrom: ['json:$.messageId']
          },
          rollback: {
            method: 'DELETE',
            pathTemplate: '/messages/{id}'
          }
        }
      ]
    });

    const workspace = await createWorkspace();
    const journal = new Journal(constantClockOptions(join(workspace, 'intents.jsonl')));
    const driver = new HttpPostDriver({ rollbackRegistry: registry });
    const intent: Intent<HttpPostPayload, HttpPostReceipt> = {
      type: 'http.post',
      idempotencyKey: 'http-rollback-1',
      payload: {
        url,
        body: { message: 'hello world' }
      }
    };

    const prepared = await driver.prepare(intent, { journal });
    const receipt = await driver.commit(intent, prepared, { journal });

    expect(receipt.metadata?.rollbackRule?.name).toBe('message-create');
    expect(receipt.metadata?.rollbackRule?.id).toBe('msg-42');
    expect(receipt.metadata?.rollbackRule?.method).toBe('DELETE');

    await driver.rollback(intent, prepared, { journal });
    expect(deletedPath).toBe('/messages/msg-42');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('labels rollback as manual when registry extraction fails', async () => {
    const server = createServer((req, res) => {
      if (req.method === 'POST') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/messages`;

    const registry = createHttpRollbackRegistry({
      rules: [
        {
          name: 'message-create-missing-id',
          host: '127.0.0.1',
          commit: {
            method: 'POST',
            path: '/messages',
            idFrom: ['json:$.missing']
          },
          rollback: {
            method: 'DELETE',
            pathTemplate: '/messages/{id}'
          }
        }
      ]
    });

    const workspace = await createWorkspace();
    const journal = new Journal(constantClockOptions(join(workspace, 'intents.jsonl')));
    const driver = new HttpPostDriver({ rollbackRegistry: registry });
    const intent: Intent<HttpPostPayload, HttpPostReceipt> = {
      type: 'http.post',
      idempotencyKey: 'http-rollback-2',
      payload: {
        url,
        body: { message: 'no-id' }
      }
    };

    const prepared = await driver.prepare(intent, { journal });
    await driver.commit(intent, prepared, { journal });

    expect(prepared.metadata).toBeUndefined();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await driver.rollback(intent, prepared, { journal });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Intent http-rollback-2 requires manual remediation (non-reversible).')
    );
    warnSpy.mockRestore();

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

function constantClockOptions(filePath: string): JournalOptions {
  return {
    filePath,
    clock: () => FIXED_DATE
  };
}

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'journal-sdk-'));
  cleanup.push(dir);
  return dir;
}
