import { Hono } from "hono";

export const healthRoutes = new Hono<{ Bindings: Env }>();

healthRoutes.get("/health", (context) => context.json({ status: "ok" }));
