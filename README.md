# @star48/artemis-provenance-sdk-node

Thin TypeScript/Node client for the **Provenance data plane** — mark and verify
AI-generated media (image · video · audio) for EU AI Act Article 50(2)
compliance. The SDK contains **no marking logic**; it calls the data-plane
container the customer runs in their own network, so content never leaves the VPC.

```bash
npm install @star48/artemis-provenance-sdk-node
```

## Usage

```ts
import { Client, MarkingUnavailableError } from '@star48/artemis-provenance-sdk-node';

const pv = new Client({
  endpoint: 'http://provenance-dp.internal:8080',
  apiKey: process.env.PROVENANCE_LOCAL_API_KEY!,
});

// Mark an asset at the end of your generation pipeline.
try {
  const marked = await pv.markImage(bytes, { appId: 'avatar-studio' });
  // marked.bytes  → the marked output to ship
  // marked.eventId, marked.payloadId, marked.sha256, marked.marks
} catch (err) {
  if (err instanceof MarkingUnavailableError) {
    // Decide fail-open (ship unmarked — a compliance gap) vs fail-closed.
  }
}

// Verify locally — content never leaves your network; only the id is resolved.
const result = await pv.verify(bytes, { contentType: 'image' });
// result.result === 'matched' | 'no-match', result.event, result.checks, result.local
```

## Fail modes

`MarkingUnavailableError` is catchable so your pipeline chooses fail-open vs
fail-closed **consciously** — document the compliance implications of each.

## License

MIT
