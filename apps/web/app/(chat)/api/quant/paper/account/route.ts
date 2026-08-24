import { auth } from "@/app/(auth)/auth";
import { cachedQuantRead } from "@/lib/quant/cache";
import { fetchQuantPaperAccount } from "@/lib/quant/client";
import {
  persistQuantPaperAccountSnapshot,
  readPersistedQuantPaperAccount,
} from "@/lib/quant/direct-snapshot";
import { NextResponse } from "next/server";

const ACCOUNT_TIMEOUT_MS = 800;
const ACCOUNT_PENDING = Symbol("account-pending");

function configuredTimeout() {
  const configured = Number(process.env.QUANT_DIRECT_ACCOUNT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : ACCOUNT_TIMEOUT_MS;
}

function withTimeout<T>(promise: Promise<T>) {
  return Promise.race<T | typeof ACCOUNT_PENDING>([
    promise,
    new Promise<typeof ACCOUNT_PENDING>((resolve) => {
      setTimeout(() => resolve(ACCOUNT_PENDING), configuredTimeout());
    }),
  ]);
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const accountPromise = cachedQuantRead({
      key: "quant:paper:account",
      fetcher: fetchQuantPaperAccount,
    });
    accountPromise.catch(() => undefined);

    const persisted = await readPersistedQuantPaperAccount({
      userId: session.user.id,
      warning:
        "Quant paper account is refreshing in background; returning persisted snapshot.",
    });
    if (persisted) {
      void accountPromise
        .then((account) =>
          persistQuantPaperAccountSnapshot({
            userId: session.user.id,
            account,
          }),
        )
        .catch(() => undefined);
      return NextResponse.json(persisted);
    }

    const account = await withTimeout(accountPromise);
    if (account === ACCOUNT_PENDING) {
      const stale = await readPersistedQuantPaperAccount({
        userId: session.user.id,
        warning:
          "Quant paper account refresh is still running; returning persisted snapshot.",
      });
      if (stale) return NextResponse.json(stale);
      throw new Error("Quant paper account refresh timed out");
    }

    await persistQuantPaperAccountSnapshot({
      userId: session.user.id,
      account,
    }).catch(() => undefined);
    return NextResponse.json(account);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "模拟盘账户暂不可用";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
