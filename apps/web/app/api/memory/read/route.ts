import { ownerMemoryRequest } from "../_shared";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return ownerMemoryRequest(request, (client, body) => client.read(body));
}
