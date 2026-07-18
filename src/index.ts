/**
 * Provenance Node/TypeScript SDK (C4). Thin by design — contains NO marking
 * logic; it serializes calls to the customer-deployed data plane (spec §9).
 */

/**
 * The data plane could not be reached or could not mark the asset. Catch this to
 * decide fail-open (ship unmarked — a compliance gap) vs fail-closed (block the
 * asset). The choice is the customer's to make; document the implications.
 */
export class MarkingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkingUnavailableError';
  }
}

export interface MarkedAsset {
  bytes: Uint8Array;
  eventId: string;
  payloadId: number;
  sha256: string;
  marks: { c2pa: string; watermark: string };
  mime: string;
}

export interface ClientOptions {
  endpoint: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface MarkImageOptions {
  appId: string;
  entityId?: string;
  context?: { title?: string };
  filename?: string;
}

export interface VerifyResult {
  result: 'matched' | 'no-match';
  method: string | null;
  event: Record<string, unknown> | null;
  checks: {
    watermark?: { present?: boolean; payloadId?: string | null; engine?: string | null };
    c2pa?: { present?: boolean; validationState?: string | null };
    sha256?: { value?: string };
  };
  local: boolean;
}

export class Client {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.endpoint = opts.endpoint.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /**
   * Verify LOCALLY via the data plane — the content never leaves your network;
   * only the extracted id is resolved against the control plane.
   */
  async verify(
    media: Uint8Array,
    opts: { contentType?: string; filename?: string } = {},
  ): Promise<VerifyResult> {
    const form = new FormData();
    form.append('file', new Blob([media as unknown as BlobPart]), opts.filename ?? 'asset');
    if (opts.contentType) form.append('content_type', opts.contentType);

    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/verify`, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey },
        body: form,
      });
    } catch (err) {
      throw new MarkingUnavailableError(`data plane unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new MarkingUnavailableError(`verify failed ${res.status}: ${await res.text().catch(() => '')}`);
    }
    return (await res.json()) as VerifyResult;
  }

  async markImage(image: Uint8Array, opts: MarkImageOptions): Promise<MarkedAsset> {
    const form = new FormData();
    const filename = opts.filename ?? 'asset';
    form.append('file', new Blob([image as unknown as BlobPart]), filename);
    form.append('app_id', opts.appId);
    form.append('entity_id', opts.entityId ?? 'default');
    form.append('title', opts.context?.title ?? filename);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/mark`, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey },
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      throw new MarkingUnavailableError(`data plane unreachable: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 503) {
      throw new MarkingUnavailableError(`marking unavailable: ${await res.text().catch(() => '')}`);
    }
    if (!res.ok) {
      throw new MarkingUnavailableError(`mark failed ${res.status}: ${await res.text().catch(() => '')}`);
    }

    const d = (await res.json()) as {
      eventId: string;
      payloadId: number;
      sha256: string;
      marks: { c2pa: string; watermark: string };
      mime: string;
      marked: string;
    };
    return {
      bytes: base64ToBytes(d.marked),
      eventId: d.eventId,
      payloadId: d.payloadId,
      sha256: d.sha256,
      marks: d.marks,
      mime: d.mime,
    };
  }
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
