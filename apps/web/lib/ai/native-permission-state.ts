export const permissionResponses = new Map<
  string,
  {
    ownerId: string;
    resolve: (result: {
      behavior: "allow" | "deny";
      updatedInput?: Record<string, unknown>;
    }) => void;
    reject: (error: Error) => void;
  }
>();



