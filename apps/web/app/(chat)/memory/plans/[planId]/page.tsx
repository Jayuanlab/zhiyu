import { auth } from "@/app/(auth)/auth";
import { MemoryPlanReview } from "@/components/memory-plan-review";
export default async function MemoryPlanReviewPage({ params }: { params: Promise<{ planId: string }> }) {
  const [session, route] = await Promise.all([auth(), params]);
  return <MemoryPlanReview ownerId={session?.user?.id ?? null} planId={route.planId} />;
}
