import { getStore } from "@netlify/blobs";
import { makeHandler } from "../lib/core.mjs";

export default makeHandler(() => getStore({ name: "team-douche", consistency: "strong" }));

export const config = { path: "/api/*" };
