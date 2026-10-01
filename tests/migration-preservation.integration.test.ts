import { env } from "cloudflare:test";
import { it, expect } from "vitest";
import m1 from "../migrations/0001_initial.sql?raw";
import m2 from "../migrations/0002_stations.sql?raw";
import m3 from "../migrations/0003_add_transcription_checkpoint.sql?raw";
import m4 from "../migrations/0004_add_audio_job_user_id.sql?raw";
import m5 from "../migrations/0005_create_guild_access.sql?raw";
import m6 from "../migrations/0006_station_line_paths.sql?raw";
import m7 from "../migrations/0007_job_monitor_messages.sql?raw";
import m8 from "../migrations/0008_job_monitor_observations.sql?raw";
import m9 from "../migrations/0009_pipeline_deadlines.sql?raw";
import m10 from "../migrations/0010_static_railway.sql?raw";
const apply = async (sql: string) => {
  for (const statement of sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    await env.DB.prepare(statement).run();
};
it("retains legacy clip/raw/IDs and does not charge unstarted queue wait to a processing deadline", async () => {
  for (const sql of [m1, m2, m3, m4, m5, m6, m7, m8]) await apply(sql);
  await env.DB.prepare(
    "INSERT INTO stations(id,name,normalized_name) VALUES(999,'野洲','野洲')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO audio_jobs(id,interaction_id,attachment_id,original_filename,size_bytes,status,created_at,transcription_text) VALUES('queued','i','a','source.mp3',3,'queued','2026-10-01T00:00:00Z','immutable raw')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO railway_audio_clips(id,job_id,clip_index,raw_transcription,normalized_transcription,category,created_at,resolved_station_id) VALUES('clip','queued',1,'immutable raw','derived prose','other','2026-10-01T00:00:00Z',999)",
  ).run();
  await apply(m9);
  await apply(m10);
  expect(
    await env.DB.prepare(
      "SELECT processing_started_at,deadline_at FROM audio_jobs WHERE id='queued'",
    ).first(),
  ).toEqual({ processing_started_at: null, deadline_at: null });
  expect(
    await env.DB.prepare(
      "SELECT raw_transcription,normalized_transcription,resolved_station_id,railway_data_version FROM railway_audio_clips WHERE id='clip'",
    ).first(),
  ).toEqual({
    raw_transcription: "immutable raw",
    normalized_transcription: "derived prose",
    resolved_station_id: 999,
    railway_data_version: "legacy-d1",
  });
  expect(
    (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
  ).toEqual([]);
});
