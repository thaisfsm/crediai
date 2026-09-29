import { toNextJsHandler } from "better-auth/next-js";

async function getAuthHandlers() {
  const { auth } = await import("@/lib/auth");
  return toNextJsHandler(auth);
}

export async function GET(request: Request) {
  const { GET: handleGet } = await getAuthHandlers();
  return handleGet(request);
}

export async function POST(request: Request) {
  const { POST: handlePost } = await getAuthHandlers();
  return handlePost(request);
}
