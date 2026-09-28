import { getUserContacts } from "@/lib/db/queries";
import { AppError } from "@openzhiyu/shared/errors";

export async function queryContactsForUser(input: {
  userId: string;
  filter?: {
    name?: string;
  };
  page?: number;
  pageSize?: number;
  getContacts?: typeof getUserContacts;
}) {
  try {
    const page =
      typeof input.page === "number" && Number.isFinite(input.page)
        ? Math.max(1, Math.trunc(input.page))
        : 1;
    const pageSize =
      typeof input.pageSize === "number" && Number.isFinite(input.pageSize)
        ? Math.max(1, Math.min(100, Math.trunc(input.pageSize)))
        : 10;
    const contacts = await (input.getContacts ?? getUserContacts)(input.userId);
    let resultContacts = contacts.map((contact) => ({
      name: contact.contactName,
      type: contact.type,
    }));

    if (input.filter?.name) {
      const searchTerm = input.filter.name.toLowerCase();
      resultContacts = resultContacts.filter((contact) =>
        contact.name?.toLowerCase().includes(searchTerm),
      );
    }

    const totalCount = resultContacts.length;
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedContacts = resultContacts.slice(startIndex, endIndex);
    const totalPages = Math.ceil(totalCount / pageSize);
    const responseData = {
      success: paginatedContacts.length > 0,
      message:
        paginatedContacts.length > 0
          ? `Successfully retrieved ${paginatedContacts.length} contact(s) (page ${page} of ${totalPages})`
          : "No contacts found in this page",
      contacts: paginatedContacts,
      pagination: {
        page,
        pageSize,
        totalCount,
        totalPages,
        hasMore: page < totalPages,
        hasPrevious: page > 1,
      },
    };

    return {
      ok: true,
      text: JSON.stringify(responseData, null, 2),
      data: responseData,
    };
  } catch (error) {
    const errorMessage =
      error instanceof AppError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Unknown error occurred while querying contacts";
    return {
      ok: false,
      isError: true,
      text: `Failed to query contacts: ${errorMessage}`,
    };
  }
}

