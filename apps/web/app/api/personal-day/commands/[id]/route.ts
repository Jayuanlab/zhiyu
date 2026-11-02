import {
  dayOwner,
  dayErrorResponse,
  privateHeaders,
} from '@/lib/personal-day/http';
import { dayCommandStatus } from '@/lib/personal-day/store';
import { z } from 'zod';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return Response.json(
      await dayCommandStatus(
        await dayOwner(request),
        z
          .string()
          .uuid()
          .parse((await params).id),
      ),
      { headers: privateHeaders },
    );
  } catch (error) {
    return dayErrorResponse(error);
  }
}
