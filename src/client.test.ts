import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client, MarkingFailedError, MarkingUnavailableError, TEXT_VERDICTS } from './index.js';

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

describe('Node SDK text methods', () => {
  const markTextResponse = {
    eventId: '01TXT',
    payloadId: 99,
    sha256: 'b'.repeat(64),
    textCanonicalHash: 'c'.repeat(64),
    canonicalization: 'textcanon.v1',
    contentType: 'text',
    mime: 'text/plain; charset=utf-8',
    marks: { c2pa: 'applied', watermark: 'not-applicable' },
    softBinding: { applied: false, scheme: null },
    manifestJws: 'eyJhbGciOiJFUzI1NiJ9.payload.sig',
    marked: Buffer.from('Attested text.\n', 'utf-8').toString('base64'),
    text: 'Attested text.\n',
  };

  it('markText parses a MarkedText (record-only default)', async () => {
    let sentBody: FormData | undefined;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('/mark/text');
      sentBody = init?.body as FormData;
      return new Response(JSON.stringify(markTextResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = new Client({ endpoint: 'http://dp.internal:8080', apiKey: 'k' });
    const attested = await client.markText('Attested text.\n', { appId: 'newsroom' });
    expect(sentBody?.get('text')).toBe('Attested text.\n');
    expect(sentBody?.get('app_id')).toBe('newsroom');
    expect(sentBody?.get('entity_id')).toBe('default');
    expect(sentBody?.get('soft_binding')).toBeNull();
    expect(sentBody?.get('title')).toBeNull();
    expect(sentBody?.get('context_json')).toBeNull();
    expect(attested.eventId).toBe('01TXT');
    expect(attested.payloadId).toBe(99);
    expect(attested.text).toBe('Attested text.\n');
    expect(Buffer.from(attested.bytes).toString()).toBe('Attested text.\n');
    expect(attested.sha256PreEmbed).toBeUndefined();
    expect(attested.textCanonicalHash).toBe('c'.repeat(64));
    expect(attested.canonicalization).toBe('textcanon.v1');
    expect(attested.marks.watermark).toBe('not-applicable');
    expect(attested.softBinding).toEqual({ applied: false, scheme: null });
    expect(attested.manifestJws).toBe('eyJhbGciOiJFUzI1NiJ9.payload.sig');
  });

  it('markText sends soft_binding, title and context_json', async () => {
    let sentBody: FormData | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sentBody = init?.body as FormData;
      return new Response(
        JSON.stringify({
          ...markTextResponse,
          sha256PreEmbed: 'd'.repeat(64),
          marks: { c2pa: 'applied', watermark: 'applied' },
          softBinding: { applied: true, scheme: 'zwsb.v1' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const client = new Client({ endpoint: 'http://dp.internal:8080', apiKey: 'k' });
    const attested = await client.markText('hello', {
      appId: 'newsroom',
      entityId: 'acme',
      softBinding: true,
      context: { title: 'Note', model: 'some-model' },
    });
    expect(sentBody?.get('entity_id')).toBe('acme');
    expect(sentBody?.get('soft_binding')).toBe('true');
    expect(sentBody?.get('title')).toBe('Note');
    expect(JSON.parse(String(sentBody?.get('context_json')))).toEqual({ model: 'some-model' });
    expect(attested.sha256PreEmbed).toBe('d'.repeat(64));
    expect(attested.softBinding).toEqual({ applied: true, scheme: 'zwsb.v1' });
  });

  it('markText throws MarkingUnavailableError on 503', async () => {
    globalThis.fetch = vi.fn(async () => new Response('exhausted', { status: 503 })) as typeof fetch;
    const client = new Client({ endpoint: 'http://dp.internal:8080', apiKey: 'k' });
    await expect(client.markText('t', { appId: 'a' })).rejects.toBeInstanceOf(
      MarkingUnavailableError,
    );
  });

  it('markText throws MarkingUnavailableError when the data plane is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const client = new Client({ endpoint: 'http://dp.internal:8080', apiKey: 'k' });
    await expect(client.markText('t', { appId: 'a' })).rejects.toBeInstanceOf(
      MarkingUnavailableError,
    );
  });

  it('verifyText posts the text and returns the verdict', async () => {
    let sentBody: FormData | undefined;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('/verify/text');
      sentBody = init?.body as FormData;
      return new Response(
        JSON.stringify({
          result: 'matched',
          verdict: 'canonical-match',
          method: 'textcanon',
          event: { eventId: '01TXT' },
          checks: {
            sha256: { value: 'b'.repeat(64) },
            textCanonical: { value: 'c'.repeat(64), algorithm: 'textcanon.v1' },
            softBinding: { present: false, valid: false, payloadId: null, scheme: 'zwsb.v1' },
          },
          generationWatermark: {
            status: 'not-checked',
            reason: 'provider detection APIs are access-gated',
          },
          shortText: false,
          notes: ['matches attested text up to formatting/invisible-character changes'],
          local: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const client = new Client({ endpoint: 'http://dp.internal:8080', apiKey: 'k' });
    const res = await client.verifyText('some text');
    expect(sentBody?.get('text')).toBe('some text');
    expect(res.verdict).toBe('canonical-match');
    expect(TEXT_VERDICTS).toContain(res.verdict);
    expect(res.method).toBe('textcanon');
    expect(res.generationWatermark.status).toBe('not-checked');
    expect(res.shortText).toBe(false);
    expect(res.local).toBe(true);
  });

  it('verifyText throws MarkingUnavailableError on error status', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as typeof fetch;
    const client = new Client({ endpoint: 'http://dp.internal:8080', apiKey: 'k' });
    await expect(client.verifyText('t')).rejects.toBeInstanceOf(MarkingUnavailableError);
  });
});

describe('AI-generation declaration', () => {
  const markTextResponse = {
    eventId: '01TXT',
    payloadId: 99,
    sha256: 'b'.repeat(64),
    textCanonicalHash: 'c'.repeat(64),
    canonicalization: 'textcanon.v1',
    marks: { c2pa: 'applied', watermark: 'not-applicable' },
    softBinding: { applied: false, scheme: null },
    manifestJws: 'h.p.s',
    marked: Buffer.from('t', 'utf-8').toString('base64'),
    text: 't',
  };

  function stub(extra: Record<string, unknown>, capture: { body?: FormData }) {
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capture.body = init?.body as FormData;
      return new Response(JSON.stringify({ ...markTextResponse, ...extra }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  }

  it('markText sends no field when undeclared; the data plane defaults it to AI', async () => {
    const cap: { body?: FormData } = {};
    const AI = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';
    stub({ aiGenerated: true, digitalSourceType: AI }, cap);
    const client = new Client({ endpoint: 'http://dp.internal:8080', apiKey: 'k' });
    const attested = await client.markText('t', { appId: 'a' });
    // The field stays off the wire — absence IS the declaration, and the data
    // plane resolves it to trainedAlgorithmicMedia (Article 50 default).
    expect(cap.body?.get('ai_generated')).toBeNull();
    expect(attested.aiGenerated).toBe(true);
    expect(attested.digitalSourceType).toBe(AI);
  });

  it('markText forwards an explicit declaration and echoes what was signed', async () => {
    const cap: { body?: FormData } = {};
    const AI = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';
    stub({ aiGenerated: true, digitalSourceType: AI }, cap);
    const client = new Client({ endpoint: 'http://dp.internal:8080', apiKey: 'k' });
    const attested = await client.markText('t', { appId: 'a', aiGenerated: true });
    expect(cap.body?.get('ai_generated')).toBe('true');
    expect(attested.aiGenerated).toBe(true);
    expect(attested.digitalSourceType).toBe(AI);

    const cap2: { body?: FormData } = {};
    const HUMAN = 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation';
    stub({ aiGenerated: false, digitalSourceType: HUMAN }, cap2);
    const human = await client.markText('t', { appId: 'a', aiGenerated: false });
    expect(cap2.body?.get('ai_generated')).toBe('false');
    expect(human.aiGenerated).toBe(false);
    expect(human.digitalSourceType).toBe(HUMAN);
  });

  it('markImage carries the same declaration', async () => {
    let sentBody: FormData | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sentBody = init?.body as FormData;
      return new Response(
        JSON.stringify({
          eventId: '01ABC',
          payloadId: 7,
          sha256: 'a'.repeat(64),
          marks: { c2pa: 'applied', watermark: 'applied' },
          mime: 'image/png',
          aiGenerated: false,
          digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation',
          marked: Buffer.from('m').toString('base64'),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const client = new Client({ endpoint: 'http://dp.internal:8080', apiKey: 'k' });
    const asset = await client.markImage(new Uint8Array([1]), { appId: 'a', aiGenerated: false });
    expect(sentBody?.get('ai_generated')).toBe('false');
    expect(asset.aiGenerated).toBe(false);
    expect(asset.digitalSourceType).toContain('digitalCreation');
  });

  it('markImage echoes null when the response omits the field entirely', async () => {
    let sentBody: FormData | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sentBody = init?.body as FormData;
      return new Response(
        JSON.stringify({
          eventId: '01ABC',
          payloadId: 7,
          sha256: 'a'.repeat(64),
          marks: { c2pa: 'applied', watermark: 'applied' },
          mime: 'image/png',
          marked: Buffer.from('m').toString('base64'),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const client = new Client({ endpoint: 'http://dp.internal:8080', apiKey: 'k' });
    const asset = await client.markImage(new Uint8Array([1]), { appId: 'a' });
    // No field on the wire (the data plane defaults it), and a response that
    // carries no echo — an older data plane — parses to null, never a guess.
    expect(sentBody?.get('ai_generated')).toBeNull();
    expect(asset.aiGenerated).toBeNull();
    expect(asset.digitalSourceType).toBeNull();
  });
});

/**
 * Fail-closed marking. An unreachable data plane and a failed mark are the same
 * compliance outcome — nothing was marked — so they must reach the caller the
 * same way: raised, never resolved. Unmarked bytes are only ever obtainable
 * through an explicit catch.
 */
describe('Node SDK fail-closed marking', () => {
  const rejected = {
    code: 'marking_failed',
    contentType: 'image',
    requiredMark: 'watermark',
    reason: 'ValueError: image too small to carry the reference watermark',
    onMarkingFailure: 'reject',
    eventId: '01FAIL',
    payloadId: 12,
    sha256: 'e'.repeat(64),
    marks: { c2pa: 'applied', watermark: 'failed' },
    detail: 'required mark (watermark) could not be produced for image',
    marked: null,
  };

  it('markImage throws MarkingFailedError on a 422 marking_failed refusal', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(rejected), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
    const client = new Client({ endpoint: 'http://dp.internal:8080', apiKey: 'k' });

    const err = await client.markImage(new Uint8Array([1]), { appId: 'a' }).catch((e) => e);
    expect(err).toBeInstanceOf(MarkingFailedError);
    expect(err.requiredMark).toBe('watermark');
    expect(err.eventId).toBe('01FAIL');
    expect(err.detail.onMarkingFailure).toBe('reject');
    expect(err.detail.reason).toContain('image too small');
    // Nothing to ship: the data plane refused, so there is no asset at all.
    expect(err.unmarked).toBeNull();
    // Same contract as an unreachable data plane — existing fail-open/
    // fail-closed handling applies unchanged.
    expect(err).toBeInstanceOf(MarkingUnavailableError);
  });

  it('markImage throws (never resolves) when a return_unmarked tenant gets unmarked bytes', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            eventId: '01OPEN',
            payloadId: 13,
            sha256: 'f'.repeat(64),
            marks: { c2pa: 'applied', watermark: 'failed' },
            mime: 'image/png',
            marked: Buffer.from('UNMARKED').toString('base64'),
            markingFailed: true,
            markingFailure: {
              ...rejected,
              eventId: '01OPEN',
              onMarkingFailure: 'return_unmarked',
              warning: 'REQUIRED MARK MISSING (watermark). These bytes are NOT marked',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as typeof fetch;
    const client = new Client({ endpoint: 'http://dp.internal:8080', apiKey: 'k' });

    const err = await client.markImage(new Uint8Array([1]), { appId: 'a' }).catch((e) => e);
    expect(err).toBeInstanceOf(MarkingFailedError);
    expect(err.detail.onMarkingFailure).toBe('return_unmarked');
    expect(err.detail.warning).toContain('NOT marked');
    // The unmarked output is reachable ONLY here, so shipping it is a choice.
    expect(Buffer.from(err.unmarked.bytes).toString()).toBe('UNMARKED');
    expect(err.unmarked.eventId).toBe('01OPEN');
  });

  it('markText throws MarkingFailedError when the signed manifest is missing', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 'marking_failed',
            contentType: 'text',
            requiredMark: 'signed-manifest',
            reason: 'RuntimeError: KMS unavailable',
            onMarkingFailure: 'reject',
            eventId: '01TXTFAIL',
            payloadId: 42,
            sha256: 'b'.repeat(64),
            marks: { c2pa: 'failed', watermark: 'not-applicable' },
          }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        ),
    ) as typeof fetch;
    const client = new Client({ endpoint: 'http://dp.internal:8080', apiKey: 'k' });

    const err = await client.markText('t', { appId: 'a' }).catch((e) => e);
    expect(err).toBeInstanceOf(MarkingFailedError);
    expect(err.requiredMark).toBe('signed-manifest');
    expect(err.unmarked).toBeNull();
  });

  it('markText hands back the unattested text through the error under return_unmarked', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            eventId: '01TXTOPEN',
            payloadId: 43,
            sha256: 'b'.repeat(64),
            textCanonicalHash: 'c'.repeat(64),
            canonicalization: 'textcanon.v1',
            contentType: 'text',
            mime: 'text/plain; charset=utf-8',
            marks: { c2pa: 'failed', watermark: 'not-applicable' },
            softBinding: { applied: false, scheme: null },
            manifestJws: null,
            marked: Buffer.from('unattested', 'utf-8').toString('base64'),
            text: 'unattested',
            markingFailed: true,
            markingFailure: {
              code: 'marking_failed',
              contentType: 'text',
              requiredMark: 'signed-manifest',
              reason: 'RuntimeError: KMS unavailable',
              onMarkingFailure: 'return_unmarked',
              eventId: '01TXTOPEN',
              payloadId: 43,
              sha256: 'b'.repeat(64),
              marks: { c2pa: 'failed', watermark: 'not-applicable' },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as typeof fetch;
    const client = new Client({ endpoint: 'http://dp.internal:8080', apiKey: 'k' });

    const err = await client.markText('unattested', { appId: 'a' }).catch((e) => e);
    expect(err).toBeInstanceOf(MarkingFailedError);
    expect(err.unmarked.text).toBe('unattested');
    expect(err.unmarked.manifestJws).toBeNull();
  });

  it('a FastAPI request-validation 422 is NOT read as a marking failure', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: [{ loc: ['body', 'app_id'], msg: 'field required' }] }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
    const client = new Client({ endpoint: 'http://dp.internal:8080', apiKey: 'k' });

    const err = await client.markImage(new Uint8Array([1]), { appId: 'a' }).catch((e) => e);
    expect(err).toBeInstanceOf(MarkingUnavailableError);
    expect(err).not.toBeInstanceOf(MarkingFailedError);
  });
});
