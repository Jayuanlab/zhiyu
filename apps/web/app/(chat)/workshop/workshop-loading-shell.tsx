import { Skeleton } from "@openzhiyu/ui";

function SkeletonLine({ className }: { className: string }) {
  return <Skeleton className={className} />;
}

export function WorkshopLoadingShell() {
  return (
    <main className="h-full min-h-0 overflow-y-auto bg-[#FAFAFA]">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between gap-3 border-b border-[#E5E5E5] pb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className="h-px w-6 bg-[#7C3AED]"
                aria-hidden="true"
              />
              <SkeletonLine className="h-3 w-20" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <SkeletonLine className="h-9 w-24 rounded-md" />
          </div>
        </header>

        <section className="border border-[#E5E5E5] bg-white px-3 py-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <SkeletonLine className="h-4 w-24" />
            <SkeletonLine className="h-7 w-16" />
          </div>
          <div className="-mx-1 flex gap-2 overflow-hidden px-1 pb-1">
            {Array.from({ length: 5 }).map((_, index) => (
              <SkeletonLine
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed loading agent selector
                key={index}
                className="h-14 min-w-[148px] max-w-[210px] shrink-0 rounded-none border border-[#E5E5E5]"
              />
            ))}
          </div>
        </section>

        <section className="border border-[#E5E5E5] bg-white p-4 sm:p-6">
          <SkeletonLine className="h-4 w-56" />
          <SkeletonLine className="mt-5 h-12 w-full max-w-3xl" />
          <div className="mt-6 border border-[#E5E5E5] bg-[#FCFCFC] px-4 py-5 sm:px-6">
            {Array.from({ length: 9 }).map((_, index) => (
              <SkeletonLine
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed loading markdown lines
                key={index}
                className={index % 3 === 0 ? "mt-3 h-4 w-5/6" : "mt-3 h-4 w-full"}
              />
            ))}
          </div>
          <div className="mt-6 flex gap-2">
            <SkeletonLine className="h-9 w-20 rounded-md" />
            <SkeletonLine className="h-9 w-24 rounded-md" />
            <SkeletonLine className="h-9 w-24 rounded-md" />
          </div>
        </section>
      </div>
    </main>
  );
}
