import { sync } from "./_lib.mjs";
export default async () => {
  const { state, news } = await sync();
  console.log("jeu-sync", state.counts, news.length, "nouveau(x) tirage(s)", state.lastError || "");
  return new Response("ok");
};
export const config = { schedule: "@hourly" };
