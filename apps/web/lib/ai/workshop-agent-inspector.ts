import type { Workshop } from "@/lib/db/schema";
import { getWorkModelSnapshot, listWorks } from "@/lib/work-runtime";

function compactWorkshopForAgent(workshop: Workshop) {
  return {
    id: workshop.id,
    name: workshop.name,
    mission: workshop.mission,
    status: workshop.status,
    autonomyLevel: workshop.autonomyLevel,
    boundaryPolicy: workshop.boundaryPolicy,
    modelConfig: workshop.modelConfig,
    updatedAt: workshop.updatedAt,
  };
}

export async function inspectWorkshopAgentForUser(input: {
  userId: string;
  workshopId?: string;
  workshopName?: string;
}) {
  const workList = await listWorks({
    userId: input.userId,
    limit: 100,
  });
  const workshops = workList.works.map((item) => item.workshop) as Workshop[];
  const target =
    workshops.find((item) => item.id === input.workshopId) ??
    workshops.find((item) => item.name === input.workshopName) ??
    (input.workshopName
      ? workshops.find((item) => item.name.includes(input.workshopName!))
      : null);
  const work = target
    ? (await getWorkModelSnapshot({
        userId: input.userId,
        workId: target.id,
      }))?.work ?? null
    : null;

  return {
    ok: true,
    target: target ? compactWorkshopForAgent(target) : null,
    work,
    workshops: workshops.map((item) => ({
      id: item.id,
      name: item.name,
      status: item.status,
      autonomyLevel: item.autonomyLevel,
    })),
    instruction:
      "修改智能体前必须先阅读 work.controlContract、work.skillBindings、work.loopBindings 和 work.changeControl。修改时调用 proposeWorkshopAgentChange，只提交窄 patch；会影响边界、工具、自动化、真实外部动作的变更必须进入主人审核。",
  };
}

