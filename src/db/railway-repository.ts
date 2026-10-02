import { D1PhoneticCandidateSource } from "./phonetic-candidate-source";
import {
  StaticRailwayRepository,
  createStaticRailwayJobCache,
} from "../stations/static-repository";
import { railwayIndexes } from "../stations/static-data";
import manifest from "../../data/generated/manifest.json";

/** Deployment-wide data source composition; identical for public and demo. */
export function createRailwayRepository(db: D1Database) {
  return new StaticRailwayRepository(
    railwayIndexes,
    createStaticRailwayJobCache(),
    new D1PhoneticCandidateSource(db, manifest.sourceSha256),
  );
}
