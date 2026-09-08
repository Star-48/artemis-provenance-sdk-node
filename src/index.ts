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

/** The tenant policy that decided a marking failure — policy `rules.onMarkingFailure`. */
export type OnMarkingFailure = 'reject' | 'return_unmarked';

/**
 * Machine-readable detail of a marking failure, as the data plane reports it.
 * `code` is the stable discriminator: HTTP 422 bodies carrying
 * `code: 'marking_failed'` are this, and FastAPI's own request-validation 422
 * (which carries `detail` and no `code`) is not.
 */
export interface MarkingFailureDetail {
  code: 'marking_failed';
  /** 'image' | 'video' | 'audio' | 'text'. */
  contentType: string;
  /** The mark the modality's compliance claim rests on and that is MISSING. */
  requiredMark: 'watermark' | 'signed-manifest';
  /** Why it could not be produced (the underlying media/engine/signer error). */
  reason: string;
  onMarkingFailure: OnMarkingFailure;
  /** The evidence event that records the failure — it is written either way. */
  eventId: string;
  payloadId: number;
  sha256: string;
  marks: { c2pa: string; watermark: string };
  /** Present on a `return_unmarked` response; spells out that nothing is marked. */
  warning?: string;
}

/**
 * The data plane RAN and could not produce the required mark — the invisible
 * watermark for image/video/audio, the detached signed manifest for text.
 *
 * Deliberately a subclass of {@link MarkingUnavailableError}: an unreachable
 * data plane and a failed mark are the SAME compliance outcome (nothing was
 * marked), so a pipeline that already chose fail-open or fail-closed for one
 * gets the identical behaviour for the other with no code change. Catch this
 * type specifically when you want the detail — or the unmarked bytes.
 *
 * `unmarked` is populated only under the tenant policy
 * `onMarkingFailure = return_unmarked`: the data plane returned the UNMARKED
 * output and it reaches you here, never as a resolved promise, so unmarked
 * content can only ever be shipped by an explicit `catch`. Under the default
 * `reject` policy no asset exists and `unmarked` is null.
 */
export class MarkingFailedError extends MarkingUnavailableError {
  readonly detail: MarkingFailureDetail;
  readonly unmarked: MarkedAsset | MarkedText | null;

  constructor(detail: MarkingFailureDetail, unmarked: MarkedAsset | MarkedText | null = null) {
    super(
      `required mark (${detail.requiredMark}) could not be produced for ${detail.contentType}: ` +
        `${detail.reason} [policy ${detail.onMarkingFailure}, event ${detail.eventId}]`,
    );
    this.name = 'MarkingFailedError';
    this.detail = detail;
    this.unmarked = unmarked;
  }

  /** The mark that is missing: 'watermark' (media) or 'signed-manifest' (text). */
  get requiredMark(): 'watermark' | 'signed-manifest' {
    return this.detail.requiredMark;
  }

  /** Id of the evidence event that records this failure on the chain. */
  get eventId(): string {
    return this.detail.eventId;
  }
}

/**
 * The `markingFailure` block from a flagged 200, or a synthesized one if a data
 * plane ever sets `markingFailed` without it. Never trusts the flag silently.
 */
function markingFailureOf(
  body: {
    markingFailure?: MarkingFailureDetail;
    eventId?: string;
    payloadId?: number;
    sha256?: string;
    marks?: { c2pa: string; watermark: string };
    contentType?: string;
  },
  requiredMark: 'watermark' | 'signed-manifest',
): MarkingFailureDetail {
  return (
    body.markingFailure ?? {
      code: 'marking_failed',
      contentType: body.contentType ?? (requiredMark === 'signed-manifest' ? 'text' : 'unknown'),
      requiredMark,
      reason: 'the data plane flagged this output as unmarked',
      onMarkingFailure: 'return_unmarked',
      eventId: body.eventId ?? '',
      payloadId: body.payloadId ?? 0,
      sha256: body.sha256 ?? '',
      marks: body.marks ?? { c2pa: 'unknown', watermark: 'unknown' },
    }
  );
}

/** A `marking_failed` body, or null when this is some other error payload. */
function parseMarkingFailure(raw: string): MarkingFailureDetail | null {
  try {
    const body = JSON.parse(raw) as Partial<MarkingFailureDetail>;
    return body && body.code === 'marking_failed' ? (body as MarkingFailureDetail) : null;
  } catch {
    return null;
  }
}

export interface MarkedAsset {
  bytes: Uint8Array;
  eventId: string;
  payloadId: number;
  sha256: string;
  marks: { c2pa: string; watermark: string };
  mime: string;
  /**
   * The AI-generation declaration recorded in the signed C2PA manifest, echoed
   * back. `true` when you declared nothing — see `MarkImageOptions.aiGenerated`.
   */
  aiGenerated: boolean | null;
  /** The IPTC digitalSourceType asserted, or `null` when none was. */
  digitalSourceType: string | null;
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
  /**
   * Declare whether this content was generated by AI. It selects the signed
   * manifest's IPTC `digitalSourceType`:
   *   `true`  -> trainedAlgorithmicMedia  (the DEFAULT when you omit this)
   *   `false` -> digitalCreation
   * Omitting it declares AI-generated: this SDK marks the output of your
   * generation pipeline, and an Article 50 disclosure is the point. Pass
   * `false` explicitly for human-made, non-generative content.
   */
  aiGenerated?: boolean;
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

/**
 * Verdicts returned by {@link Client.verifyText}, strongest first. Exported as
 * a value so callers can compare without retyping the strings.
 */
export const TEXT_VERDICTS = [
  'exact-match',
  'canonical-match',
  'softbinding-recovered',
  'no-match',
] as const;
export type TextVerdict = (typeof TEXT_VERDICTS)[number];

export interface MarkTextOptions {
  appId: string;
  entityId?: string;
  /**
   * Embed the optional zero-width soft binding (zwsb.v1). The soft binding is
   * strippable by design — normalization, sanitizers, retyping, or one free
   * paste-through tool removes it. Omit to follow the tenant policy default
   * (record-only).
   */
  softBinding?: boolean;
  /**
   * Customer-declared context strings; `title` is stored on the event, the
   * remaining keys (e.g. `model`) go to the signed manifest's `generator`.
   */
  context?: { title?: string; model?: string; [k: string]: string | undefined };
  /**
   * Declare whether this content was generated by AI. It selects the signed
   * manifest's IPTC `digitalSourceType`:
   *   `true`  -> trainedAlgorithmicMedia  (the DEFAULT when you omit this)
   *   `false` -> digitalCreation
   * Omitting it declares AI-generated: this SDK marks the output of your
   * generation pipeline, and an Article 50 disclosure is the point. Pass
   * `false` explicitly for human-made, non-generative content.
   */
  aiGenerated?: boolean;
}

export interface MarkedText {
  /** The text to publish — identical to the input unless the soft binding was applied. */
  text: string;
  /** UTF-8 bytes of `text` (what `sha256` is computed over). */
  bytes: Uint8Array;
  eventId: string;
  payloadId: number;
  /** SHA-256 of the returned output bytes (hex). */
  sha256: string;
  /** SHA-256 of the pre-embed bytes — present only when the soft binding was applied. */
  sha256PreEmbed?: string;
  /** Canonical text hash (textcanon.v1) — the formatting-robust match key. */
  textCanonicalHash: string;
  canonicalization: 'textcanon.v1';
  /**
   * Frozen mark keys: `c2pa` = the detached signed manifest; `watermark` = the
   * soft-binding slot ('not-applicable' in record-only mode) — NOT a text
   * watermark.
   */
  marks: { c2pa: string; watermark: string };
  softBinding: { applied: boolean; scheme: string | null };
  /**
   * The AI-generation declaration recorded in the signed manifest, echoed back.
   * `true` when you declared nothing — see `MarkTextOptions.aiGenerated`.
   */
  aiGenerated: boolean | null;
  /** The IPTC digitalSourceType asserted, or `null` when none was. */
  digitalSourceType: string | null;
  /**
   * Detached signed manifest (compact JWS, ES256, your KMS key). Portable —
   * serve it alongside the text; losing it loses nothing evidentiary.
   *
   * Always present on a resolved `markText`. It is `null` ONLY on the
   * `MarkedText` attached to a {@link MarkingFailedError} — the missing
   * manifest IS that failure.
   */
  manifestJws: string | null;
}

export interface VerifyTextResult {
  result: 'matched' | 'no-match';
  verdict: TextVerdict;
  method: 'sha256' | 'textcanon' | 'payload' | null;
  event: Record<string, unknown> | null;
  checks: {
    sha256: { value: string };
    textCanonical: { value: string; algorithm: string };
    softBinding: { present: boolean; valid: boolean; payloadId: string | null };
  };
  generationWatermark: { status: 'not-checked'; reason: string };
  shortText: boolean;
  notes: string[];
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
    if (opts.aiGenerated !== undefined) {
      form.append('ai_generated', opts.aiGenerated ? 'true' : 'false');
    }

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

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      if (res.status === 503) throw new MarkingUnavailableError(`marking unavailable: ${raw}`);
      // Fail closed: the data plane refused because the watermark could not be
      // embedded. No asset exists to hand back.
      const failure = parseMarkingFailure(raw);
      if (failure) throw new MarkingFailedError(failure);
      throw new MarkingUnavailableError(`mark failed ${res.status}: ${raw}`);
    }

    const d = (await res.json()) as {
      eventId: string;
      payloadId: number;
      sha256: string;
      marks: { c2pa: string; watermark: string };
      mime: string;
      aiGenerated?: boolean | null;
      digitalSourceType?: string | null;
      marked: string;
      markingFailed?: boolean;
      markingFailure?: MarkingFailureDetail;
    };
    const asset: MarkedAsset = {
      bytes: base64ToBytes(d.marked),
      eventId: d.eventId,
      payloadId: d.payloadId,
      sha256: d.sha256,
      marks: d.marks,
      mime: d.mime,
      aiGenerated: d.aiGenerated ?? null,
      digitalSourceType: d.digitalSourceType ?? null,
    };
    // A 200 does NOT mean marked: under `onMarkingFailure = return_unmarked`
    // the data plane returns the unmarked bytes, flagged. Never resolve with
    // them — shipping unmarked content must take an explicit catch.
    if (d.markingFailed) throw new MarkingFailedError(markingFailureOf(d, 'watermark'), asset);
    return asset;
  }

  /**
   * Attest text via the data plane: canonical hashes + a KMS-signed detached
   * manifest, plus an OPTIONAL zero-width soft binding. markText attests, it
   * does not watermark — no robust post-hoc text watermark exists. The soft
   * binding is strippable — normalization, sanitizers, retyping, or one free
   * paste-through tool removes it; the durable evidence is the registry record
   * plus the detached manifest, not anything hidden in the text.
   *
   * The manifest declares the text AI-generated unless you pass
   * `aiGenerated: false` — see `MarkTextOptions.aiGenerated`.
   */
  async markText(text: string, opts: MarkTextOptions): Promise<MarkedText> {
    const form = new FormData();
    form.append('text', text);
    form.append('app_id', opts.appId);
    form.append('entity_id', opts.entityId ?? 'default');
    const { title, ...generator } = opts.context ?? {};
    if (title !== undefined) form.append('title', title);
    if (opts.softBinding !== undefined) {
      form.append('soft_binding', opts.softBinding ? 'true' : 'false');
    }
    if (opts.aiGenerated !== undefined) {
      form.append('ai_generated', opts.aiGenerated ? 'true' : 'false');
    }
    const generatorEntries = Object.entries(generator).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    );
    if (generatorEntries.length > 0) {
      form.append('context_json', JSON.stringify(Object.fromEntries(generatorEntries)));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/mark/text`, {
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

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      if (res.status === 503) throw new MarkingUnavailableError(`marking unavailable: ${raw}`);
      // Text's required mark is the SIGNED MANIFEST; a failed optional soft
      // binding is not a marking failure and never lands here.
      const failure = parseMarkingFailure(raw);
      if (failure) throw new MarkingFailedError(failure);
      throw new MarkingUnavailableError(`mark text failed ${res.status}: ${raw}`);
    }

    const d = (await res.json()) as {
      eventId: string;
      payloadId: number;
      sha256: string;
      sha256PreEmbed?: string | null;
      textCanonicalHash: string;
      canonicalization: 'textcanon.v1';
      marks: { c2pa: string; watermark: string };
      softBinding: { applied: boolean; scheme: string | null };
      aiGenerated?: boolean | null;
      digitalSourceType?: string | null;
      manifestJws: string | null;
      marked: string;
      text: string;
      contentType?: string;
      markingFailed?: boolean;
      markingFailure?: MarkingFailureDetail;
    };
    const attested: MarkedText = {
      text: d.text,
      bytes: base64ToBytes(d.marked),
      eventId: d.eventId,
      payloadId: d.payloadId,
      sha256: d.sha256,
      textCanonicalHash: d.textCanonicalHash,
      canonicalization: d.canonicalization,
      marks: d.marks,
      softBinding: d.softBinding,
      aiGenerated: d.aiGenerated ?? null,
      digitalSourceType: d.digitalSourceType ?? null,
      manifestJws: d.manifestJws,
    };
    if (d.sha256PreEmbed != null) attested.sha256PreEmbed = d.sha256PreEmbed;
    // Unattested text under `onMarkingFailure = return_unmarked` reaches the
    // caller the same way an unmarked image does: raised, never resolved.
    if (d.markingFailed) throw new MarkingFailedError(markingFailureOf(d, 'signed-manifest'), attested);
    return attested;
  }

  /**
   * Verify text LOCALLY via the data plane — the text never leaves your
   * network; only ids/hashes are resolved against the control plane. Verdict
   * ladder: exact-match → canonical-match → softbinding-recovered (a pointer
   * was found but the content does not match the attested text — treat as
   * unverified) → no-match. A no-match proves nothing about origin: unmarked,
   * edited, paraphrased, translated, or third-party text all produce it, and
   * no AI-vs-human inference is ever made.
   */
  async verifyText(text: string): Promise<VerifyTextResult> {
    const form = new FormData();
    form.append('text', text);

    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/verify/text`, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey },
        body: form,
      });
    } catch (err) {
      throw new MarkingUnavailableError(`data plane unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new MarkingUnavailableError(`verify text failed ${res.status}: ${await res.text().catch(() => '')}`);
    }
    return (await res.json()) as VerifyTextResult;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
