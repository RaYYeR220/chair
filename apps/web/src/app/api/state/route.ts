import { connection } from "next/server";
import { getState } from "@/lib/server/chair";
import { CACHE, fail, json } from "@/lib/server/http";

/** Everything the token shows now: levers, curve, funds, endowment and IQ tier, queue, next meeting. */
export async function GET() {
  await connection();
  try {
    return json(await getState(), { cache: CACHE.live });
  } catch (e) {
    return fail(e);
  }
}
