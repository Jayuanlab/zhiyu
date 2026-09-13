"use client";

import { useRouter } from "next/navigation";
import { PageSectionHeader } from "@openzhiyu/ui";
import { WechatWorkbenchPanel } from "@/components/wechat-workbench-panel";

export default function WechatWorkbenchPage() {
  const router = useRouter();

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col">
      <PageSectionHeader
        title="微信代看"
        footer={
          <p className="text-sm text-muted-foreground">
            替你把微信消息整理成待办、待回复、风险、场景状态和可审核记忆。
          </p>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        <WechatWorkbenchPanel
          onOpenReview={() => router.push("/knowledge-pipeline?view=memory")}
        />
      </div>
    </div>
  );
}
