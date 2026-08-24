"use client";

import { fetcher as defaultFetcher } from "@/lib/utils";
import useSWR, { type SWRConfiguration, type SWRResponse } from "swr";

type PageStateMeta = {
  stale?: boolean;
  refreshing?: boolean;
};

export type PageStateOptions<Data> = SWRConfiguration<Data> & {
  dedupingInterval?: number;
  refreshInterval?: number;
  keepPreviousData?: boolean;
  revalidateOnFocus?: boolean;
};

export type PageStateResponse<Data, Error = unknown> = SWRResponse<
  Data,
  Error
> & {
  isInitialLoading: boolean;
  isRefreshing: boolean;
  isStale: boolean;
};

function readMeta(value: unknown): PageStateMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const meta = (value as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  return meta as PageStateMeta;
}

export function usePageState<Data = unknown, Error = unknown>(
  key: string | null,
  options: PageStateOptions<Data> = {},
): PageStateResponse<Data, Error> {
  const response = useSWR<Data, Error>(key, defaultFetcher, {
    dedupingInterval: 5_000,
    keepPreviousData: true,
    revalidateOnFocus: false,
    ...options,
  });
  const meta = readMeta(response.data);
  const isInitialLoading = !response.data && response.isLoading;
  const isRefreshing = Boolean(response.data && response.isLoading);

  return {
    ...response,
    isInitialLoading,
    isRefreshing: Boolean(meta.refreshing) || isRefreshing,
    isStale: Boolean(meta.stale),
  };
}
