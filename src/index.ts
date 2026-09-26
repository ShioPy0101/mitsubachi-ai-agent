import { Hono } from "hono";
import { consumeAudioJobs } from "./jobs/consumer";
import type { AudioJobMessage } from "./jobs/types";
import { healthRoutes } from "./routes/health";
import { interactionRoutes } from "./routes/interactions";

const app = new Hono<{ Bindings: Env }>();
app.route("/", healthRoutes);
app.route("/", interactionRoutes);
app.notFound((context) => context.json({ error: "not_found" }, 404));

export default {
  fetch: app.fetch,
  queue: consumeAudioJobs,
} satisfies ExportedHandler<Env, AudioJobMessage>;
