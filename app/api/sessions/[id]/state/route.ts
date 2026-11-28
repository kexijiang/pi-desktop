import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { readInlineWorkflowState } from "@/lib/workflow-runtime";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    if (!await resolveSessionPath(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const inlineWorkflow = readInlineWorkflowState(id);
    const workflowFields = inlineWorkflow.status === "ok"
      ? { workflowSnapshot: inlineWorkflow.snapshot, workflowStateStatus: "ok" as const }
      : inlineWorkflow.status === "corrupt"
        ? { workflowStateStatus: "corrupt" as const }
        : {};
    const rpc = getRpcSession(id);
    if (!rpc?.isAlive()) {
      return NextResponse.json({ running: false, ...workflowFields });
    }

    const view = new URL(req.url).searchParams.get("view");
    const state = await rpc.send({ type: "get_state", ...(view === "chat" ? { view } : {}) });
    return NextResponse.json({ running: true, state, ...workflowFields });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
