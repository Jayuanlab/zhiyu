import { and, desc, eq, inArray } from "drizzle-orm";
import { AppError } from "@openzhiyu/shared/errors";
import { isTauriMode } from "@/lib/env/constants";
import type { IntegrationId } from "@/lib/integrations/client";
import { invalidateRuntimeConnectorCountsCache } from "@/lib/runtime/status-cache";
import { db } from "./client";
import {
  bot,
  integrationAccounts,
  user,
  userContacts,
  type Bot,
  type IntegrationAccount,
} from "./schema";
import {
  decryptPayload,
  deserializeJson,
  encryptPayload,
  serializeJson,
} from "./serialization";

export type IntegrationAccountWithBot = IntegrationAccount & {
  bot: Bot | null;
};

function withParsedBot(accountBot: Bot | null) {
  return accountBot
    ? {
        ...accountBot,
        adapterConfig: deserializeJson(
          accountBot.adapterConfig as
            | string
            | Record<string, unknown>
            | unknown[]
            | null
            | undefined,
        ),
      }
    : null;
}

export async function getIntegrationAccountsByUserId({
  userId,
}: {
  userId: string;
}): Promise<IntegrationAccountWithBot[]> {
  try {
    const rows = await db
      .select({
        account: integrationAccounts,
        bot,
      })
      .from(integrationAccounts)
      .leftJoin(bot, eq(bot.platformAccountId, integrationAccounts.id))
      .where(eq(integrationAccounts.userId, userId))
      .orderBy(desc(integrationAccounts.createdAt));

    return rows.map(({ account, bot: botRow }: any) => {
      const rawMeta = account.metadata;
      const parsedMeta =
        isTauriMode() && typeof rawMeta === "string" && rawMeta.length > 0
          ? (JSON.parse(rawMeta) as Record<string, unknown>)
          : rawMeta;
      return {
        ...account,
        metadata: parsedMeta,
        bot: withParsedBot(botRow),
      };
    });
  } catch (error) {
    throw new AppError(
      "bad_request:database",
      `Failed to load integration accounts. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function getIntegrationAccountByPlatform({
  userId,
  platform,
}: {
  userId: string;
  platform: IntegrationId;
}): Promise<IntegrationAccountWithBot | null> {
  try {
    const [row] = await db
      .select({
        account: integrationAccounts,
        bot,
      })
      .from(integrationAccounts)
      .leftJoin(bot, eq(bot.platformAccountId, integrationAccounts.id))
      .where(
        and(
          eq(integrationAccounts.userId, userId),
          eq(integrationAccounts.platform, platform),
        ),
      )
      .orderBy(desc(integrationAccounts.createdAt))
      .limit(1);

    if (!row) return null;
    return {
      ...row.account,
      bot: withParsedBot(row.bot),
    };
  } catch (error) {
    throw new AppError(
      "bad_request:database",
      `Failed to load integration account for platform ${platform}. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function getIntegrationAccountById({
  userId,
  platformAccountId,
}: {
  userId: string;
  platformAccountId: string;
}): Promise<IntegrationAccountWithBot | null> {
  try {
    const [row] = await db
      .select({
        account: integrationAccounts,
        bot,
      })
      .from(integrationAccounts)
      .leftJoin(bot, eq(bot.platformAccountId, integrationAccounts.id))
      .where(
        and(
          eq(integrationAccounts.userId, userId),
          eq(integrationAccounts.id, platformAccountId),
        ),
      )
      .limit(1);

    if (!row) return null;
    return {
      ...row.account,
      bot: withParsedBot(row.bot),
    };
  } catch (error) {
    throw new AppError(
      "bad_request:database",
      `Failed to load integration account ${platformAccountId}. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function getIntegrationAccountByBotId({
  botId,
}: {
  botId: string;
}): Promise<IntegrationAccountWithBot | null> {
  try {
    const [row] = await db
      .select({
        account: integrationAccounts,
        bot,
      })
      .from(bot)
      .leftJoin(
        integrationAccounts,
        eq(bot.platformAccountId, integrationAccounts.id),
      )
      .where(eq(bot.id, botId))
      .limit(1);

    if (!row) return null;
    return {
      ...row.account,
      bot: withParsedBot(row.bot),
    };
  } catch (error) {
    throw new AppError(
      "bad_request:database",
      `Failed to load account for bot ${botId}. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function upsertIntegrationAccount({
  userId,
  platform,
  externalId,
  displayName,
  credentials,
  metadata,
  status = "active",
  encryptionKeyId = null,
}: {
  userId: string;
  platform: IntegrationAccount["platform"];
  externalId: string;
  displayName: string;
  credentials: Record<string, unknown>;
  metadata?: Record<string, unknown> | null;
  status?: string;
  encryptionKeyId?: string | null;
}): Promise<IntegrationAccount> {
  try {
    const now = new Date();
    const encryptedCredentials = encryptPayload(credentials);

    if (platform === "telegram") {
      const existingAccount = await db
        .select()
        .from(integrationAccounts)
        .where(
          and(
            eq(integrationAccounts.userId, userId),
            eq(integrationAccounts.platform, platform),
            eq(integrationAccounts.externalId, externalId),
          ),
        )
        .limit(1);

      if (existingAccount.length > 0) {
        const [updated] = await db
          .update(integrationAccounts)
          .set({
            displayName,
            status,
            metadata: serializeJson(metadata),
            credentialsEncrypted: encryptedCredentials,
            encryptionKeyId,
            updatedAt: now,
          })
          .where(eq(integrationAccounts.id, existingAccount[0].id))
          .returning();
        invalidateRuntimeConnectorCountsCache(userId);
        return updated;
      }
    }

    if (isTauriMode()) {
      const [existingUser] = await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);

      if (!existingUser) {
        await db.insert(user).values({
          id: userId,
          email: `${userId}@local`,
          name: userId,
        });
      }

      const existing = await db
        .select()
        .from(integrationAccounts)
        .where(
          and(
            eq(integrationAccounts.userId, userId),
            eq(integrationAccounts.platform, platform),
            eq(integrationAccounts.externalId, externalId),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        const [updated] = await db
          .update(integrationAccounts)
          .set({
            displayName,
            status,
            metadata: serializeJson(metadata),
            credentialsEncrypted: encryptedCredentials,
            encryptionKeyId,
            updatedAt: now,
          })
          .where(eq(integrationAccounts.id, existing[0].id))
          .returning();
        invalidateRuntimeConnectorCountsCache(userId);
        return updated;
      }

      const [inserted] = await db
        .insert(integrationAccounts)
        .values({
          userId,
          platform,
          externalId,
          displayName,
          status,
          metadata: serializeJson(metadata),
          credentialsEncrypted: encryptedCredentials,
          encryptionKeyId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      invalidateRuntimeConnectorCountsCache(userId);
      return inserted;
    }

    const [account] = await db
      .insert(integrationAccounts)
      .values({
        userId,
        platform,
        externalId,
        displayName,
        status,
        metadata: serializeJson(metadata),
        credentialsEncrypted: encryptedCredentials,
        encryptionKeyId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          integrationAccounts.userId,
          integrationAccounts.platform,
          integrationAccounts.externalId,
        ],
        set: {
          displayName,
          status,
          metadata: serializeJson(metadata),
          credentialsEncrypted: encryptedCredentials,
          encryptionKeyId,
          updatedAt: now,
        },
      })
      .returning();

    invalidateRuntimeConnectorCountsCache(userId);
    return account;
  } catch (error) {
    console.error("[IntegrationAccounts] Failed to upsert account", {
      userId,
      platform,
      externalId,
      error,
    });
    throw new AppError(
      "bad_request:database",
      `Failed to store integration account. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function updateIntegrationAccount({
  userId,
  platformAccountId,
  status,
  credentials,
  metadata,
}: {
  userId: string;
  platformAccountId: string;
  status?: string;
  credentials?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}): Promise<IntegrationAccount | null> {
  try {
    const updatePayload: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (typeof status === "string") updatePayload.status = status;

    if (metadata !== undefined) {
      const value = metadata ?? null;
      updatePayload.metadata =
        value !== null && typeof value === "object"
          ? (serializeJson(value) as Record<string, unknown>)
          : value;
    }

    if (credentials !== undefined) {
      updatePayload.credentialsEncrypted = encryptPayload(
        credentials ?? Object.create(null),
      );
    }

    if (
      updatePayload.status === undefined &&
      updatePayload.metadata === undefined &&
      updatePayload.credentialsEncrypted === undefined
    ) {
      return await getIntegrationAccountById({
        userId,
        platformAccountId,
      });
    }

    const [updatedAccount] = await db
      .update(integrationAccounts)
      .set(updatePayload)
      .where(
        and(
          eq(integrationAccounts.userId, userId),
          eq(integrationAccounts.id, platformAccountId),
        ),
      )
      .returning();

    if (updatedAccount) {
      invalidateRuntimeConnectorCountsCache(userId);
    }

    return updatedAccount ?? null;
  } catch (error) {
    console.error("[IntegrationAccounts] Failed to update account", error);
    throw new AppError(
      "bad_request:database",
      `Unable to update integration account ${platformAccountId}. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function deleteIntegrationAccount({
  userId,
  platformAccountId,
}: {
  userId: string;
  platformAccountId: string;
}): Promise<{ deletedAccountId: string | null; deletedBots: string[] }> {
  try {
    const botsToDelete = await db
      .select({ id: bot.id, adapter: bot.adapter })
      .from(bot)
      .where(
        and(
          eq(bot.userId, userId),
          eq(bot.platformAccountId, platformAccountId),
        ),
      );

    const botIds = botsToDelete.map((b: any) => b.id);
    if (botIds.length > 0) {
      const weixinBotIds = botsToDelete
        .filter((b: any) => b.adapter === "weixin")
        .map((b: any) => b.id);

      if (weixinBotIds.length > 0) {
        await db
          .delete(userContacts)
          .where(
            and(
              eq(userContacts.userId, userId),
              inArray(userContacts.botId, weixinBotIds),
            ),
          );
      }

      await db
        .delete(bot)
        .where(and(eq(bot.userId, userId), inArray(bot.id, botIds)));
    }

    const [deletedAccount] = await db
      .delete(integrationAccounts)
      .where(
        and(
          eq(integrationAccounts.userId, userId),
          eq(integrationAccounts.id, platformAccountId),
        ),
      )
      .returning({ id: integrationAccounts.id });

    if (deletedAccount) {
      invalidateRuntimeConnectorCountsCache(userId);
    }

    return {
      deletedAccountId: deletedAccount?.id ?? null,
      deletedBots: botIds,
    };
  } catch (error) {
    throw new AppError(
      "bad_request:database",
      `Failed to delete integration account ${platformAccountId}. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function loadIntegrationCredentials<T = Record<string, unknown>>(
  account: IntegrationAccount | null,
): T | null;
export function loadIntegrationCredentials<T = Record<string, unknown>>(
  account: IntegrationAccount | null,
  auditContext?: {
    userId: string;
    ipAddress?: string;
    userAgent?: string;
  },
): T | null;
export function loadIntegrationCredentials<T = Record<string, unknown>>(
  account: IntegrationAccount | null,
  auditContext?: {
    userId: string;
    ipAddress?: string;
    userAgent?: string;
  },
): T | null {
  if (!account || !account.credentialsEncrypted) return null;

  if (auditContext) {
    try {
      const { logCredentialAccess } = require("@openzhiyu/audit");
      logCredentialAccess({
        accountId: account.id,
        userId: auditContext.userId,
        action: "read",
        ipAddress: auditContext.ipAddress,
        userAgent: auditContext.userAgent,
        success: true,
      });
    } catch {
      // Ignore audit logging errors - should not break credential loading.
    }
  }

  return decryptPayload<T>(account.credentialsEncrypted);
}
