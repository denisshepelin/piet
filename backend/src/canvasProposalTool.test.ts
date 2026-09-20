import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCanvasProposalTool, type CanvasProposal } from "./canvasProposalTool.js";

// SAFETY: createCanvasProposalTool does not read the extension context.
const unusedExtensionContext = {} as ExtensionContext;

test("captures an ordered shape proposal without a canvas request", async () => {
  const proposals: CanvasProposal[] = [];

  const tool = createCanvasProposalTool((proposal) => {
    proposals.push(proposal);
  });

  const result = await tool.execute(
    "proposal-1",
    {
      type: "shapes",
      shapes: [
        { type: "geo", x: 10, y: 20, props: { geo: "rectangle", w: 200, h: 100 } },
        { type: "text", x: 40, y: 60, text: "Review" },
      ],
    },
    undefined,
    undefined,
    unusedExtensionContext,
  );

  assert.deepEqual(proposals, [result.details]);
  assert.equal(tool.name, "propose_canvas");
  const content = result.content[0];
  assert.equal(content?.type, "text");

  if (content?.type === "text") assert.match(content.text, /2 shape/);
});

test("captures an image proposal without fetching or mutating the canvas", async () => {
  let captured: CanvasProposal | undefined;

  const tool = createCanvasProposalTool((proposal) => {
    captured = proposal;
  });

  await tool.execute(
    "proposal-image",
    {
      type: "image",
      src: "https://example.com/diagram.png",
      altText: "Reference diagram",
      x: 20,
      y: 40,
    },
    undefined,
    undefined,
    unusedExtensionContext,
  );
  assert.deepEqual(captured, {
    type: "image",
    src: "https://example.com/diagram.png",
    altText: "Reference diagram",
    x: 20,
    y: 40,
  });
});

test("captures a Mermaid proposal with optional page-space placement", async () => {
  let captured: CanvasProposal | undefined;

  const tool = createCanvasProposalTool((proposal) => {
    captured = proposal;
  });

  await tool.execute(
    "proposal-2",
    {
      type: "mermaid",
      source: "graph TD; A --> B",
      x: 100,
      y: 200,
    },
    undefined,
    undefined,
    unusedExtensionContext,
  );

  assert.deepEqual(captured, {
    type: "mermaid",
    source: "graph TD; A --> B",
    x: 100,
    y: 200,
  });
});
