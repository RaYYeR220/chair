import { connection } from "next/server";
import { listMeetings } from "@/lib/server/history";
import { CACHE, fail, json } from "@/lib/server/http";

/** Every meeting the contract still holds, newest first (views only; details at /api/meetings/[n]). */
export async function GET() {
  await connection();
  try {
    return json(await listMeetings(), { cache: CACHE.short });
  } catch (e) {
    return fail(e);
  }
}
