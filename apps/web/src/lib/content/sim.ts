import "server-only";
import v1 from "@results/sim-2026-11-10.json";
import v3 from "@results/sim-v3-2026-11-10.json";
import { deriveSim, type SimV1, type SimV3 } from "./sim-derive";

/**
 * The simulation as the landing draws it, from the same committed file that
 * /api/sim serves (plus the per-day runs that route leaves out). Read once at
 * module scope: the files never change after a run.
 */
export const SIM = deriveSim(v3 as unknown as SimV3, v1 as unknown as SimV1, "results/sim-v3-2026-11-10.json");
