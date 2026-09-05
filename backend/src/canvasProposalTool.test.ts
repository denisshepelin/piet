import assert from "node:assert/strict";
import test from "node:test";
import { createCanvasProposalTool, type CanvasProposal } from "./canvasProposalTool.js";

test("captures an ordered shape proposal without a canvas request", async () => {
  const proposals: CanvasProposal[] = [];
  const tool = createCanvasProposalTool((proposal) => {
    proposals.push(proposal);
  });

  type ProposalExecutor = (
    toolCallId: string,
    proposal: CanvasProposal,
  ) => Promise<{ readonly details: CanvasProposal; readonly content: readonly { text: string }[] }>;
  // SAFETY: the extension context is unused by the proposal tool test.
  const result = await (tool.execute as unknown as ProposalExecutor)("proposal-1", {
    type: "shapes",
    shapes: [
      { type: "geo", x: 10, y: 20, props: { geo: "rectangle", w: 200, h: 100 } },
      { type: "text", x: 40, y: 60, text: "Review" },
    ],
  });

  assert.deepEqual(proposals, [result.details]);
  assert.equal(tool.name, "propose_canvas");
  assert.match(result.content[0]?.text ?? "", /2 shape/);
});

test("captures an image proposal without fetching or mutating the canvas", async () => {
  let captured: CanvasProposal | undefined;
  const tool = createCanvasProposalTool((proposal) => {
    captured = proposal;
  });
  type ProposalExecutor = (
    toolCallId: string,
    proposal: CanvasProposal,
  ) => Promise<{ readonly details: CanvasProposal }>;
  // SAFETY: the extension context is unused by this tool; the public tool adapter requires it in its signature.
  await (tool.execute as unknown as ProposalExecutor)("proposal-image", {
    type: "image",
    src: "https://example.com/diagram.png",
    altText: "Reference diagram",
    x: 20,
    y: 40,
  });
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

  type ProposalExecutor = (
    toolCallId: string,
    proposal: CanvasProposal,
  ) => Promise<{ readonly details: CanvasProposal }>;
  // SAFETY: the extension context is unused by the proposal tool test.
  await (tool.execute as unknown as ProposalExecutor)("proposal-2", {
    type: "mermaid",
    source: "graph TD; A --> B",
    x: 100,
    y: 200,
  });

  assert.deepEqual(captured, {
    type: "mermaid",
    source: "graph TD; A --> B",
    x: 100,
    y: 200,
  });
});
