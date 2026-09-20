import { Type, type Static } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { canvasActionSchemas } from "@piet/protocol";

const MAX_MERMAID_SOURCE_LENGTH = 50_000;

const proposedElementsSchema = canvasActionSchemas.put_shapes.params.properties.shapes;

const canvasProposalSchema = Type.Union([
  Type.Object({ type: Type.Literal("image"), ...canvasActionSchemas.put_image.params.properties }),
  Type.Object({
    type: Type.Literal("shapes"),
    shapes: proposedElementsSchema,
  }),
  Type.Object({
    type: Type.Literal("mermaid"),
    source: Type.String({ minLength: 1, maxLength: MAX_MERMAID_SOURCE_LENGTH }),
    x: Type.Optional(Type.Number()),
    y: Type.Optional(Type.Number()),
  }),
]);

/** A validated drawing proposal that the main agent commits at a browser boundary. */
export type CanvasProposal = Static<typeof canvasProposalSchema>;

/** Tool contract used by canvas workers to propose drawings without live canvas access. */
export type CanvasProposalTool = ToolDefinition<typeof canvasProposalSchema, CanvasProposal> &
  ReturnType<typeof defineTool>;

/**
 * Create the propose_canvas tool. The callback receives the latest validated proposal and does not
 * write to the live canvas.
 */
export const createCanvasProposalTool = (
  onProposal: (proposal: CanvasProposal) => void = () => undefined,
): CanvasProposalTool =>
  defineTool({
    name: "propose_canvas",
    label: "Propose Canvas",
    description:
      "Propose a drawing for the main agent to review and commit at the browser boundary. This tool never writes to the live canvas. Choose shapes for ordered tldraw shapes, mermaid for a diagram source, or image to import an image URL/data URL in the background.",
    promptSnippet:
      "Propose drawing changes for a later browser-side commit; never modify the live canvas.",
    promptGuidelines: [
      "Use propose_canvas once after preparing a complete drawing proposal.",
      "Use page-space coordinates from the immutable prompt canvas context.",
      "Do not claim that a proposal is visible until the main agent commits it.",
    ],
    parameters: canvasProposalSchema,
    async execute(_toolCallId, proposal) {
      onProposal(proposal);

      const count =
        proposal.type === "shapes"
          ? `${proposal.shapes.length} shape(s)`
          : proposal.type === "image"
            ? "Image import"
            : "Mermaid source";

      return {
        content: [{ type: "text", text: `Canvas proposal captured: ${count}.` }],
        details: proposal,
      };
    },
  });
