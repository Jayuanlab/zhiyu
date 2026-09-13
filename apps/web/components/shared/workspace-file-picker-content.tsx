"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import cx from "classnames";
import {usePagedWorkspaceFiles} from '@/hooks/use-paged-workspace-files';
import { getLibraryFileIconSrc } from "@/components/library/library-item-row";
import { RemixIcon } from "@/components/remix-icon";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";

type WorkspaceFileRef = {
  taskId: string;
  path: string;
  name: string;
};

type WorkspaceFilePickerContentProps = {
  taskId?: string;
  selectedRefs?: WorkspaceFileRef[];
  onAdd?: (ref: WorkspaceFileRef) => void;
  onRemove?: (path: string) => void;
  onSelect?: (file: { path: string; name: string }) => void;
  showDoneButton?: boolean;
  onClose?: () => void;
};

/**
 * Resolve workspace file extension from explicit type or filename.
 */
function resolveWorkspaceFileExt(file: {
  name: string;
  type?: string;
}): string {
  if (file.type?.trim()) return file.type.trim().toLowerCase();
  const lastDotIndex = file.name.lastIndexOf(".");
  if (lastDotIndex < 0 || lastDotIndex === file.name.length - 1) return "";
  return file.name.slice(lastDotIndex + 1).toLowerCase();
}

/**
 * Shared workspace file picker content used by chat and character pages.
 */
export function WorkspaceFilePickerContent({
  taskId,
  selectedRefs = [],
  onAdd,
  onRemove,
  onSelect,
  showDoneButton = true,
  onClose,
}: WorkspaceFilePickerContentProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const {files:loadedFiles,busy,hasMore,error,load}=usePagedWorkspaceFiles(taskId);
  const files = useMemo(
    () => loadedFiles.filter((file) => !file.isDirectory),
    [loadedFiles],
  );
  const filteredFiles = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return files;
    return files.filter((file) => {
      return (
        file.name.toLowerCase().includes(normalizedQuery) ||
        file.path.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [files, query]);

  const measureRef = useRef<HTMLSpanElement>(null);
  const [measuredContentWidth, setMeasuredContentWidth] = useState<
    number | null
  >(null);

  const longestName = useMemo(() => {
    let longest = "";
    for (const file of filteredFiles) {
      if (file.name.length > longest.length) longest = file.name;
    }
    return longest;
  }, [filteredFiles]);

  useLayoutEffect(() => {
    if (!measureRef.current) return;
    if (!longestName) {
      setMeasuredContentWidth(null);
      return;
    }
    const width = measureRef.current.offsetWidth;
    if (width > 0) {
      setMeasuredContentWidth(width + 16 + 8 + 36);
    }
  }, [longestName]);

  const containerWidth = measuredContentWidth
    ? Math.min(Math.max(measuredContentWidth, 320), 480)
    : 320;

  return (
    <div
      className="flex max-w-full flex-col gap-2 flex-1 min-h-0 h-full"
      style={{ width: `min(${containerWidth}px, calc(100vw - 1rem))` }}
    >
      <span
        ref={measureRef}
        className="invisible fixed left-0 top-0 whitespace-nowrap text-sm pointer-events-none"
        aria-hidden
      >
        {longestName}
      </span>
      <div className="relative">
        <RemixIcon
          name="search"
          size="size-4"
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
        />
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("chat.searchFiles", "Search files")}
          className="w-full rounded-md border border-input bg-background py-2 pl-8 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <ScrollArea className="flex-1 min-h-0">
        {busy && files.length===0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {t("common.loading", "Loading")}
          </div>
        ) : error && files.length===0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {error.message}
          </div>
        ) : filteredFiles.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {hasMore ? '暂未发现匹配文件，可以继续扫描。' : query.trim()
              ? t("chat.noMatch", "No matching items")
              : t(
                  "chat.workspaceFilesEmpty",
                  "No workspace files in current conversation",
                )}
          </div>
        ) : (
          <div className="flex w-full flex-col gap-1">
            {filteredFiles.map((file) => {
              const fileIconSrc = getLibraryFileIconSrc(
                resolveWorkspaceFileExt(file),
              );
              const resolvedTaskId = taskId ?? file.taskId ?? "";
              const ref: WorkspaceFileRef = {
                taskId: resolvedTaskId,
                path: file.path,
                name: file.name,
              };
              const isSelected = selectedRefs.some(
                (current) =>
                  current.taskId === resolvedTaskId &&
                  current.path === file.path,
              );
              return (
                <button
                  key={`${resolvedTaskId}:${file.path}`}
                  type="button"
                  onClick={() => {
                    if (onAdd) {
                      if (isSelected && onRemove) {
                        onRemove(file.path);
                      } else {
                        onAdd(ref);
                      }
                      return;
                    }
                    onSelect?.({ path: file.path, name: file.name });
                  }}
                  className={cx(
                    "w-full rounded-xl px-3 py-3 text-left text-sm transition-colors",
                    "hover:bg-primary-50",
                    isSelected && "bg-primary-50",
                  )}
                >
                  <span className="flex flex-1 items-center gap-2 min-w-0">
                    <img
                      src={fileIconSrc}
                      alt=""
                      draggable={false}
                      className="size-4 shrink-0 object-contain pointer-events-none"
                      aria-hidden
                    />
                    <span className="block truncate" title={file.name}>
                      {file.name}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </ScrollArea>
      <section aria-label="文件选择扫描状态" className="grid gap-2 text-xs text-muted-foreground">
        <p role="status">{error?.message??(hasMore?`已加载 ${files.length} 个文件，列表尚未完整；搜索仅匹配已加载文件。`:`扫描完成，共 ${files.length} 个文件。`)}</p>
        {hasMore||error?<Button variant="secondary" size="sm" disabled={busy} onClick={()=>void load(error?.reset??false)}>{busy?'正在读取':error?.reset?'重新扫描':error?'重试读取':'继续扫描'}</Button>:null}
      </section>
      {showDoneButton && onClose ? (
        <Button variant="secondary" size="sm" onClick={onClose}>
          {t("common.done", "Done")}
        </Button>
      ) : null}
    </div>
  );
}
