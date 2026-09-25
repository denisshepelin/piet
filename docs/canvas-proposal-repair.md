# Canvas batch validation and repair

The main agent draws through tools directly. Each canvas request is validated before being committed; no separate drawing worker or post-generation finalizer is involved.

1. `put_shapes` supplies up to 12 editable shapes. While the call streams, each finished element is sent as its own request; the rest of the call is sent together when it executes.
2. The browser prepares it in a cloned editor using current page state. Native tldraw validation catches malformed properties. Text is measured with the browser's real layout engine.
3. Strict drawing calls reject overlapping text or overflowing labels before any live changes. Feedback includes lint messages and measured page bounds. Unbound-arrow advisories do not block intentional standalone arrows.
4. A rejected request stops the rest of its `put_shapes` call. The tool error returns to the same main model and lists the shapes from that call that were already committed. The model resends only the uncommitted shapes, keeping stable IDs; committed shapes remain visible and must not be recreated.
5. A clean request commits immediately with one undo boundary, before the next model turn or final completion summary.

There is a per-turn safety budget of three rejected writes (an initial failure plus two corrections). After that, further writes are blocked for the turn. Transport failures/timeouts block subsequent writes immediately because the commit outcome may be unknown. Reads remain available. An unresolved failed mutation prevents the task from being marked done, even if unrelated drawing succeeded. Failures stay visible with retry/dismiss controls.

Cancellation preserves already-committed batches. A user-requested retry starts a new main turn and must inspect the existing canvas rather than replaying old successful batches. Whole-task rollback/undo is not implemented.

## Easier placement

Creation supports relative vertical placement:

```json
{
  "id": "recommendation",
  "type": "text",
  "text": "Stay with TypeScript for now.",
  "x": 146,
  "placement": { "below": ["pros", "cons"], "gap": 24 }
}
```

The browser calculates `y` from the tallest measured bottom, including wrapped text. References can be existing shapes or other shapes in the same request, regardless of ordering. A streamed element that references a later shape in its call is held back, so the reference and its target are sent in one request. Missing references and cycles reject the batch. Relative placement requires unrotated, page-level shapes; it does not move or resize referenced artwork.

`rotation`, `opacity`, coordinates, and `placement` are top-level fields, not shape `props`. Batch tools use the same input normalizer as single-element tools.

## Scope

These checks detect structural and text-layout problems, not aesthetic quality or whether a mascot is recognizable. They do not automatically repair old committed boards. Manual drawing retains its existing behavior. Browser tests cover atomic rejection, preservation of user artwork, measured placement, cycles, and visible failures. Main-session tests verify shapes committed while a call streams, held-back forward references, progressive commits before the final answer, bounded repair, uncertain transport failures, and continued asynchronous research.
