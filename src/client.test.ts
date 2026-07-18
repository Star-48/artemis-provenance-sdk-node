import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client, MarkingUnavailableError } from './index.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('Node SDK Client', () => {
  it('parses a MarkedAsset from the data plane response', async () => {
    const markedB64 = Buffer.from('marked-bytes').toString('base64');
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain('/mark');
      return new Response(
        JSON.stringify({
          eventId: '01ABC',
          payloadId: 7,
          sha256: 'a'.repeat(64),
          marks: { c2pa: 'applied', watermark: 'applied' },
          mime: 'image/png',
          marked: markedB64,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const client = new Client({ endpoint: 'http://dp.internal:8080', apiKey: 'k' });
    const asset = await client.markImage(new Uint8Array([1, 2, 3]), { appId: 'avatar' });
    expect(asset.eventId).toBe('01ABC');
    expect(asset.payloadId).toBe(7);
    expect(Buffer.from(asset.bytes).toString()).toBe('marked-bytes');
  });

  it('throws MarkingUnavailableError on 503', async () => {
    globalThis.fetch = vi.fn(async () => new Response('exhausted', { status: 503 })) as typeof fetch;
    const client = new Client({ endpoint: 'http://dp.internal:8080', apiKey: 'k' });
    await expect(client.markImage(new Uint8Array([1]), { appId: 'a' })).rejects.toBeInstanceOf(
      MarkingUnavailableError,
    );
  });

  it('throws MarkingUnavailableError when the data plane is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const client = new Client({ endpoint: 'http://dp.internal:8080', apiKey: 'k' });
    await expect(client.markImage(new Uint8Array([1]), { appId: 'a' })).rejects.toBeInstanceOf(
      MarkingUnavailableError,
    );
  });

  it('verify() posts to the data plane and returns the local result', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain('/verify');
      return new Response(
        JSON.stringify({
          result: 'matched',
          method: 'payload',
          event: { eventId: '01ABC' },
          checks: { watermark: { present: true, payloadId: '7' } },
          local: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const client = new Client({ endpoint: 'http://dp.internal:8080', apiKey: 'k' });
    const res = await client.verify(new Uint8Array([1, 2, 3]), { contentType: 'image' });
    expect(res.result).toBe('matched');
    expect(res.local).toBe(true);
    expect(res.checks.watermark?.payloadId).toBe('7');
  });
});
