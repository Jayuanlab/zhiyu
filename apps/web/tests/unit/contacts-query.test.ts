import { describe, expect, it, vi } from "vitest";
import { queryContactsForUser } from "@/lib/ai/contacts-query";

describe("contacts query adapter", () => {
  it("filters contacts by name and paginates owner-scoped results", async () => {
    const getContacts = vi.fn(async () => [
      {
        contactName: "Alice Zhang",
        type: "weixin",
      },
      {
        contactName: "Bob",
        type: "email",
      },
      {
        contactName: "Alicia",
        type: "weixin",
      },
    ]);

    const result = await queryContactsForUser({
      userId: "user-1",
      filter: { name: "ali" },
      page: 1,
      pageSize: 1,
      getContacts: getContacts as never,
    });

    expect(getContacts).toHaveBeenCalledWith("user-1");
    expect(result).toMatchObject({
      ok: true,
      data: {
        success: true,
        contacts: [
          {
            name: "Alice Zhang",
            type: "weixin",
          },
        ],
        pagination: {
          page: 1,
          pageSize: 1,
          totalCount: 2,
          totalPages: 2,
          hasMore: true,
          hasPrevious: false,
        },
      },
    });
    expect(result.text).toContain("Alice Zhang");
  });

  it("clamps invalid pagination input before slicing", async () => {
    const getContacts = vi.fn(async () =>
      Array.from({ length: 101 }, (_, index) => ({
        contactName: `Contact ${index + 1}`,
        type: "weixin",
      })),
    );

    const result = await queryContactsForUser({
      userId: "user-1",
      page: -10,
      pageSize: 999,
      getContacts: getContacts as never,
    });

    expect(result.data?.pagination).toMatchObject({
      page: 1,
      pageSize: 100,
      totalCount: 101,
      totalPages: 2,
      hasMore: true,
    });
    expect(result.data?.contacts).toHaveLength(100);
  });
});
