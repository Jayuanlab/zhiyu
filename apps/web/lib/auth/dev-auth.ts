import type { Session } from "next-auth";
import { getAuthMode } from "./request-boundary";

const DEFAULT_DEV_USER_ID = "dcb1985e-3fe2-42fd-8978-7b04d1772850";

export function isAuthBypassEnabled(): boolean {
  return getAuthMode() === "local_owner";
}

export function createDevSession(): Session {
  const devUserId = process.env.DEV_USER_ID?.trim() || DEFAULT_DEV_USER_ID;
  return {
    expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString(),
    user: {
      id: devUserId,
      type: "regular",
      email: "dev@openzhiyu.local",
      name: "Dev User",
      image: "https://avatar.vercel.sh/dev-openzhiyu",
      displayName: "Dev User",
      avatarUrl: "https://avatar.vercel.sh/dev-openzhiyu",
      roles: [],
      role: null,
      industry: null,
      otherRole: null,
      companySize: null,
      dailyMessages: null,
      surveyUpdatedAt: null,
    },
  };
}
