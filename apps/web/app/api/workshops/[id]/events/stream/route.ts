import { auth } from "@/app/(auth)/auth";
import { assertWorkAccess, listWorkEvents } from "@/lib/work-runtime";
import { subscribeWorkshopEvents } from "@/lib/workshops/event-bus";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

function cursor(value: string | null) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  try { await assertWorkAccess({ userId: session.user.id, workId: id }); }
  catch { return new Response("Workshop not found", { status: 404 }); }

  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let lastSentSeq = Math.max(cursor(request.nextUrl.searchParams.get("after")), cursor(request.headers.get("last-event-id")));
      let closed = false, inFlight = false, pollAgain = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe = () => {};
      const emit = (text: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(text)); } catch { stop(); }
      };
      const heartbeat = setInterval(() => emit(": keep-alive\n\n"), 30_000);
      stop = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer); clearInterval(heartbeat); unsubscribe();
        request.signal.removeEventListener("abort", stop);
        try { controller.close(); } catch {}
      };
      const schedule = (delay: number) => {
        if (closed) return;
        if (inFlight) { pollAgain = true; return; }
        clearTimeout(timer);
        timer = setTimeout(poll, delay);
      };
      const poll = async () => {
        if (closed || inFlight) return;
        inFlight = true;
        let delay = 5000;
        try {
          // The bus is only a wakeup signal. Always read the ordered durable log,
          // so another process, missed notifications and sequence gaps are safe.
          const events = await listWorkEvents({ userId: session.user.id, workId: id, afterSeq: lastSentSeq, limit: 100 });
          delay = events.length === 100 ? 0 : events.length ? 1000 : 5000;
          for (const event of events) {
            if (closed || event.seq <= lastSentSeq) continue;
            emit(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
            lastSentSeq = event.seq;
          }
        } catch (error) {
          emit(`data: ${JSON.stringify({type: "error", message: error instanceof Error ? error.message : "Workshop stream poll failed"})}\n\n`);
        } finally {
          inFlight = false;
          const nextDelay = pollAgain ? 0 : delay;
          pollAgain = false;
          schedule(nextDelay);
        }
      };
      unsubscribe = subscribeWorkshopEvents(id, () => schedule(0));
      request.signal.addEventListener("abort", stop);
      if (request.signal.aborted) stop(); else void poll();
    },
    cancel() { stop(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}
